/**
 * Contacts MCP Server — search, lookup, create, and update contacts.
 *
 * KPR-122 port: in-process via createSdkMcpServer. Tool handlers close over
 * the shared engine Db. No per-turn context is needed.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { ObjectId, type Collection, type Db } from "mongodb";
import { z } from "zod";

interface PhoneEntry {
  number: string; // E.164 (+1XXXXXXXXXX)
  formatted: string; // (XXX) XXX-XXXX
  label: string; // Primary, Mobile, Work, etc.
}

type ContactCategory = "team-human" | "customer" | "vendor" | "partner" | "archived";

interface ContactDoc {
  _id: ObjectId;
  name: string;
  firstName: string;
  lastName: string;
  email: string | null;
  phones: PhoneEntry[];
  company?: string;
  role?: string;
  pronouns?: string;
  tags: string[];
  notes?: string;
  source: string;
  sourceId?: string;
  category?: ContactCategory;
  createdAt: Date;
  updatedAt: Date;
}

export interface ContactsToolDeps {
  db: Db;
}

function normalizePhoneDigits(raw: string): string {
  let digits = raw.replace(/\D/g, "");
  if (digits.startsWith("1") && digits.length === 11) digits = digits.slice(1);
  return digits;
}

function toE164(digits: string): string {
  return `+1${digits}`;
}

function formatPhone(digits: string): string {
  return `(${digits.slice(0, 3)}) ${digits.slice(3, 6)}-${digits.slice(6)}`;
}

function formatContact(c: ContactDoc): string {
  const lines: string[] = [];
  lines.push(`Name: ${c.name}`);
  if (c.company) lines.push(`Company: ${c.company}`);
  if (c.role) lines.push(`Role: ${c.role}`);
  if (c.email) lines.push(`Email: ${c.email}`);
  if (c.phones.length) {
    lines.push(`Phone: ${c.phones.map((p) => `${p.label}: ${p.formatted}`).join(", ")}`);
  }
  if (c.tags.length) lines.push(`Tags: ${c.tags.join(", ")}`);
  if (c.notes) lines.push(`Notes: ${c.notes}`);
  lines.push(`Source: ${c.source}`);
  lines.push(`ID: ${c._id}`);
  return lines.join("\n");
}

export function buildContactsTools(deps: ContactsToolDeps) {
  const contacts: Collection<ContactDoc> = deps.db.collection<ContactDoc>("contacts");

  return [
    tool(
      "contacts_search",
      "Search contacts by name, phone number, email, or tag. Returns matching contacts with all available details.",
      {
        query: z.string().describe("Search term — a name, phone number, email address, or tag to search for"),
        limit: z.number().optional().describe("Max results (default 10)"),
      },
      async ({ query, limit }) => {
        try {
          const cap = limit ?? 10;
          const results: ContactDoc[] = [];

          const digits = query.replace(/\D/g, "");
          if (digits.length >= 7) {
            const normalized = normalizePhoneDigits(query);
            const e164 = toE164(normalized);
            const phoneResults = await contacts.find({ "phones.number": e164 }).limit(cap).toArray();
            results.push(...phoneResults);
          }

          if (query.includes("@")) {
            const emailResults = await contacts.find({ email: query.toLowerCase() }).limit(cap).toArray();
            for (const r of emailResults) {
              if (!results.some((e) => e._id.equals(r._id))) results.push(r);
            }
          }

          const tagResults = await contacts.find({ tags: query.toLowerCase() }).limit(cap).toArray();
          for (const r of tagResults) {
            if (!results.some((e) => e._id.equals(r._id))) results.push(r);
          }

          if (results.length < cap) {
            try {
              const textResults = await contacts
                .find({ $text: { $search: query } })
                .limit(cap - results.length)
                .toArray();
              for (const r of textResults) {
                if (!results.some((e) => e._id.equals(r._id))) results.push(r);
              }
            } catch {
              const regex = new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i");
              const regexResults = await contacts
                .find({ $or: [{ name: regex }, { email: regex }, { company: regex }] })
                .limit(cap - results.length)
                .toArray();
              for (const r of regexResults) {
                if (!results.some((e) => e._id.equals(r._id))) results.push(r);
              }
            }
          }

          if (results.length === 0) {
            return { content: [{ type: "text", text: `No contacts found for "${query}"` }] };
          }

          const text = results.map(formatContact).join("\n\n---\n\n");
          return { content: [{ type: "text", text: `Found ${results.length} contact(s):\n\n${text}` }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `contacts_search error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "contacts_get",
      "Retrieve a specific contact by its MongoDB ObjectId.",
      {
        id: z.string().describe("Contact ID (MongoDB ObjectId)"),
      },
      async ({ id }) => {
        try {
          const contact = await contacts.findOne({ _id: new ObjectId(id) });
          if (!contact) {
            return { content: [{ type: "text", text: `No contact found with ID ${id}` }] };
          }
          return { content: [{ type: "text", text: formatContact(contact) }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `contacts_get error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "contacts_create",
      "Create a new contact in the contacts database.",
      {
        firstName: z.string().optional().describe("First name"),
        lastName: z.string().optional().describe("Last name"),
        email: z.string().optional().describe("Email address"),
        phone: z.string().optional().describe("Phone number (any format — will be normalized)"),
        company: z.string().optional().describe("Company name"),
        role: z.string().optional().describe("Job title or role"),
        tags: z.array(z.string()).optional().describe("Tags (e.g. homeowner, contractor, designer)"),
        notes: z.string().optional().describe("Free-text notes about this contact"),
      },
      async ({ firstName, lastName, email, phone, company, role, tags, notes }) => {
        try {
          const name = [firstName, lastName].filter(Boolean).join(" ") || email?.split("@")[0] || "Unknown";
          const phones: PhoneEntry[] = [];
          if (phone) {
            const digits = normalizePhoneDigits(phone);
            if (digits.length === 10) {
              phones.push({ number: toE164(digits), formatted: formatPhone(digits), label: "Primary" });
            }
          }

          const doc: Omit<ContactDoc, "_id"> = {
            name,
            firstName: firstName || "",
            lastName: lastName || "",
            email: email?.toLowerCase() || null,
            phones,
            company: company || undefined,
            role: role || undefined,
            tags: tags || [],
            notes: notes || undefined,
            source: "manual",
            createdAt: new Date(),
            updatedAt: new Date(),
          };

          const result = await contacts.insertOne(doc as ContactDoc);
          return { content: [{ type: "text", text: `Contact created: ${name} (ID: ${result.insertedId})` }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `contacts_create error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "contacts_update",
      "Update an existing contact's details.",
      {
        id: z.string().describe("Contact ID (MongoDB ObjectId)"),
        firstName: z.string().optional().describe("First name"),
        lastName: z.string().optional().describe("Last name"),
        email: z.string().optional().describe("Email address"),
        phone: z.string().optional().describe("Phone number to add (any format)"),
        company: z.string().optional().describe("Company name"),
        role: z.string().optional().describe("Job title or role"),
        tags: z.array(z.string()).optional().describe("Tags to set (replaces existing)"),
        notes: z.string().optional().describe("Notes (replaces existing)"),
      },
      async ({ id, firstName, lastName, email, phone, company, role, tags, notes }) => {
        try {
          const updates: Record<string, unknown> = { updatedAt: new Date() };
          if (firstName !== undefined) updates.firstName = firstName;
          if (lastName !== undefined) updates.lastName = lastName;
          if (email !== undefined) updates.email = email.toLowerCase();
          if (company !== undefined) updates.company = company;
          if (role !== undefined) updates.role = role;
          if (tags !== undefined) updates.tags = tags;
          if (notes !== undefined) updates.notes = notes;

          if (firstName !== undefined || lastName !== undefined) {
            const existing = await contacts.findOne({ _id: new ObjectId(id) });
            if (existing) {
              updates.name = [firstName ?? existing.firstName, lastName ?? existing.lastName].filter(Boolean).join(" ");
            }
          }

          const ops: Record<string, unknown> = { $set: updates };

          if (phone) {
            const digits = normalizePhoneDigits(phone);
            if (digits.length === 10) {
              const entry: PhoneEntry = { number: toE164(digits), formatted: formatPhone(digits), label: "Primary" };
              ops.$addToSet = { phones: entry };
            }
          }

          const result = await contacts.updateOne({ _id: new ObjectId(id) }, ops);
          if (result.matchedCount === 0) {
            return { content: [{ type: "text", text: `No contact found with ID ${id}` }] };
          }
          return { content: [{ type: "text", text: `Contact ${id} updated` }] };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `contacts_update error: ${String(err)}` }] };
        }
      },
    ),
    tool(
      "contacts_list",
      "List contacts, optionally filtered by tag or source.",
      {
        tag: z.string().optional().describe("Filter by tag (e.g. homeowner, contractor)"),
        source: z.string().optional().describe("Filter by source system (e.g. crm, sms, email, manual)"),
        limit: z.number().optional().describe("Max results (default 25)"),
      },
      async ({ tag, source, limit }) => {
        try {
          const cap = limit ?? 25;
          const filter: Record<string, unknown> = {};
          if (tag) filter.tags = tag;
          if (source) filter.source = source;

          const results = await contacts.find(filter).sort({ name: 1 }).limit(cap).toArray();

          if (results.length === 0) {
            return { content: [{ type: "text", text: "No contacts found" }] };
          }

          const total = await contacts.countDocuments(filter);
          const lines = results.map((c) => {
            const phone = c.phones[0]?.formatted || "";
            return `- ${c.name}${phone ? ` (${phone})` : ""}${c.email ? ` <${c.email}>` : ""} [${c.tags.join(", ")}]`;
          });

          return {
            content: [
              {
                type: "text",
                text: `${total} contacts${tag ? ` tagged "${tag}"` : ""}${source ? ` from ${source}` : ""}:\n\n${lines.join("\n")}`,
              },
            ],
          };
        } catch (err) {
          return { isError: true, content: [{ type: "text", text: `contacts_list error: ${String(err)}` }] };
        }
      },
    ),
  ];
}

export function createContactsMcpServer(deps: ContactsToolDeps) {
  return createSdkMcpServer({
    name: "contacts",
    version: "0.1.0",
    tools: buildContactsTools(deps),
  });
}
