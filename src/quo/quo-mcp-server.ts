#!/usr/bin/env node

/**
 * Quo MCP Server — SMS, calls, contacts, and conversations via Quo (formerly OpenPhone) API.
 *
 * Env vars:
 *   QUO_API_KEY — required, from Quo workspace settings > API tab
 *   QUO_PHONE_NUMBER_ID — default phone number ID (PNxxx) for sending
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_KEY = process.env.QUO_API_KEY ?? "";
const DEFAULT_PHONE_ID = process.env.QUO_PHONE_NUMBER_ID ?? "";
const BASE = "https://api.openphone.com/v1";

// Named lines loaded from config (passed via QUO_LINES_JSON env var)
const LINES: Record<string, { id: string; number: string; label: string }> = (() => {
  try {
    return JSON.parse(process.env.QUO_LINES_JSON ?? "{}");
  } catch {
    return {};
  }
})();

function resolveLine(from?: string): string {
  if (!from) return DEFAULT_PHONE_ID;
  const line = LINES[from.toLowerCase()];
  if (line) return line.id;
  return from; // assume it's a PNxxx ID or E.164 number
}

async function api(method: string, path: string, body?: Record<string, unknown>, params?: Record<string, string>): Promise<string> {
  const url = new URL(`${BASE}${path}`);
  if (params) {
    for (const [k, v] of Object.entries(params)) {
      if (v) url.searchParams.append(k, v);
    }
  }

  const res = await fetch(url.toString(), {
    method,
    headers: {
      Authorization: API_KEY,
      ...(body ? { "Content-Type": "application/json" } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  const text = await res.text();
  if (!res.ok) {
    throw new Error(`Quo API ${res.status}: ${text}`);
  }
  return text;
}

const server = new McpServer({
  name: "hive-quo",
  version: "0.1.0",
});

// ── Phone Numbers ───────────────────────────────────────────────────────

server.registerTool("quo_phone_numbers", {
  title: "List Phone Numbers",
  description: "List all Quo phone numbers in the workspace. Use this to find phone number IDs needed for other operations.",
  inputSchema: {},
}, async () => {
  try {
    const result = await api("GET", "/phone-numbers");
    return { content: [{ type: "text", text: result }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
});

// ── Messages ────────────────────────────────────────────────────────────

server.registerTool("quo_send_sms", {
  title: "Send SMS",
  description: (() => {
    const lineDescs = Object.entries(LINES).map(([k, v]) => `"${k}" for ${v.label} ${v.number}`).join(", ");
    return `Send a text message via Quo.${lineDescs ? ` Available lines: ${lineDescs}.` : ""} Pass a line name or PNxxx ID.`;
  })(),
  inputSchema: {
    to: z.string().describe("Recipient phone number in E.164 format (e.g. +14085551234)"),
    content: z.string().max(1600).describe("Message text (max 1600 chars)"),
    from: z.string().optional().describe('Line to send from: "main", "personal", or a PNxxx ID. Defaults to personal.'),
  },
}, async ({ to, content, from }) => {
  try {
    const fromId = resolveLine(from);
    if (!fromId) {
      return { content: [{ type: "text", text: "No sending phone number configured. Use quo_phone_numbers to find one." }], isError: true };
    }
    const result = await api("POST", "/messages", {
      to: [to],
      content,
      from: fromId,
    });
    const line = Object.values(LINES).find((l) => l.id === fromId);
    const sent = line ? `Sent from ${line.label} ${line.number}` : `Sent from ${fromId}`;
    return { content: [{ type: "text", text: `${sent}\n\n${result}` }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
});

server.registerTool("quo_list_messages", {
  title: "List Messages",
  description: `List messages in a conversation with a specific phone number. Use "main" or "personal" for the line, or a PNxxx ID.`,
  inputSchema: {
    line: z.string().optional().default("personal").describe('Which Quo line: "main", "personal", or PNxxx ID. Defaults to personal.'),
    participant: z.string().describe("Other party's phone number in E.164 format"),
    maxResults: z.number().optional().default(20).describe("Max results (1-100, default 20)"),
    createdAfter: z.string().optional().describe("Filter: messages after this ISO 8601 timestamp"),
    createdBefore: z.string().optional().describe("Filter: messages before this ISO 8601 timestamp"),
  },
}, async ({ line, participant, maxResults, createdAfter, createdBefore }) => {
  try {
    const params: Record<string, string> = {
      phoneNumberId: resolveLine(line),
      "participants[]": participant,
      maxResults: String(maxResults),
    };
    if (createdAfter) params.createdAfter = createdAfter;
    if (createdBefore) params.createdBefore = createdBefore;
    const result = await api("GET", "/messages", undefined, params);
    return { content: [{ type: "text", text: result }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
});

// ── Conversations ───────────────────────────────────────────────────────

server.registerTool("quo_list_conversations", {
  title: "List Conversations",
  description: `List recent conversations. Use "main" or "personal" for the line, or a PNxxx ID.`,
  inputSchema: {
    line: z.string().optional().describe('Filter by line: "main", "personal", or PNxxx ID. Shows all lines if omitted.'),
    maxResults: z.number().optional().default(20).describe("Max results (1-100, default 20)"),
    updatedAfter: z.string().optional().describe("Filter: conversations updated after this ISO 8601 timestamp"),
  },
}, async ({ line, maxResults, updatedAfter }) => {
  try {
    const params: Record<string, string> = {
      maxResults: String(maxResults),
    };
    if (line) params["phoneNumbers[]"] = resolveLine(line);
    if (updatedAfter) params.updatedAfter = updatedAfter;
    const result = await api("GET", "/conversations", undefined, params);
    return { content: [{ type: "text", text: result }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
});

// ── Calls ───────────────────────────────────────────────────────────────

server.registerTool("quo_list_calls", {
  title: "List Calls",
  description: `List calls with a specific phone number. Use "main" or "personal" for the line, or a PNxxx ID.`,
  inputSchema: {
    line: z.string().optional().default("personal").describe('Which Quo line: "main", "personal", or PNxxx ID. Defaults to personal.'),
    participant: z.string().describe("Other party's phone number in E.164 format"),
    maxResults: z.number().optional().default(20).describe("Max results (1-100, default 20)"),
    createdAfter: z.string().optional().describe("Filter: calls after this ISO 8601 timestamp"),
    createdBefore: z.string().optional().describe("Filter: calls before this ISO 8601 timestamp"),
  },
}, async ({ line, participant, maxResults, createdAfter, createdBefore }) => {
  try {
    const params: Record<string, string> = {
      phoneNumberId: resolveLine(line),
      "participants[]": participant,
      maxResults: String(maxResults),
    };
    if (createdAfter) params.createdAfter = createdAfter;
    if (createdBefore) params.createdBefore = createdBefore;
    const result = await api("GET", "/calls", undefined, params);
    return { content: [{ type: "text", text: result }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
});

// ── Call Transcripts & Recordings ────────────────────────────────────────

server.registerTool("quo_get_transcript", {
  title: "Get Call Transcript",
  description: "Get the full transcript of a specific call. Use quo_list_calls first to find the call ID.",
  inputSchema: {
    callId: z.string().describe("The call ID (from quo_list_calls results)"),
  },
}, async ({ callId }) => {
  try {
    const result = await api("GET", `/call-transcripts/${callId}`);
    return { content: [{ type: "text", text: result }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
});

server.registerTool("quo_get_recording", {
  title: "Get Call Recording",
  description: "Get recording URLs for a specific call. Use quo_list_calls first to find the call ID.",
  inputSchema: {
    callId: z.string().describe("The call ID (from quo_list_calls results)"),
  },
}, async ({ callId }) => {
  try {
    const result = await api("GET", `/call-recordings/${callId}`);
    return { content: [{ type: "text", text: result }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
});

// ── Contacts ────────────────────────────────────────────────────────────

server.registerTool("quo_list_contacts", {
  title: "List Contacts",
  description: "List contacts in Quo. Returns names, phone numbers, emails, and company info.",
  inputSchema: {
    maxResults: z.number().optional().default(50).describe("Max results (1-50, default 50)"),
    pageToken: z.string().optional().describe("Pagination token for next page"),
  },
}, async ({ maxResults, pageToken }) => {
  try {
    const params: Record<string, string> = {
      maxResults: String(maxResults),
    };
    if (pageToken) params.pageToken = pageToken;
    const result = await api("GET", "/contacts", undefined, params);
    return { content: [{ type: "text", text: result }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
});

server.registerTool("quo_lookup_contact", {
  title: "Lookup Contact by Phone",
  description: "Look up a contact by phone number. Returns the contact's name, company, email, and other details if found.",
  inputSchema: {
    phoneNumber: z.string().describe("Phone number to look up (any format — will be normalized for matching)"),
  },
}, async ({ phoneNumber }) => {
  try {
    // Normalize: strip everything except digits
    const digits = phoneNumber.replace(/\D/g, "");
    // Try with and without leading 1 (US country code)
    const variants = new Set([digits, digits.replace(/^1/, ""), `1${digits.replace(/^1/, "")}`]);

    let pageToken: string | undefined;
    let found: any = null;

    // Paginate through all contacts
    for (let page = 0; page < 20 && !found; page++) {
      const params: Record<string, string> = { maxResults: "50" };
      if (pageToken) params.pageToken = pageToken;
      const result = await api("GET", "/contacts", undefined, params);
      const data = JSON.parse(result);

      for (const contact of data.data ?? []) {
        const phones: string[] = (contact.defaultFields?.phoneNumbers ?? []).map((p: any) => p.value?.replace(/\D/g, "") ?? "");
        for (const p of phones) {
          const pVariants = new Set([p, p.replace(/^1/, ""), `1${p.replace(/^1/, "")}`]);
          if ([...variants].some((v) => pVariants.has(v))) {
            found = contact;
            break;
          }
        }
        if (found) break;
      }

      pageToken = data.nextPageToken;
      if (!pageToken) break;
    }

    if (found) {
      const f = found.defaultFields ?? {};
      const name = [f.firstName, f.lastName].filter(Boolean).join(" ") || "Unknown";
      const company = f.company || "";
      const emails = (f.emails ?? []).map((e: any) => e.value).join(", ");
      const phones = (f.phoneNumbers ?? []).map((p: any) => `${p.name}: ${p.value}`).join(", ");
      const lines = [`Name: ${name}`];
      if (company) lines.push(`Company: ${company}`);
      if (f.role) lines.push(`Role: ${f.role}`);
      if (emails) lines.push(`Email: ${emails}`);
      if (phones) lines.push(`Phone: ${phones}`);
      return { content: [{ type: "text", text: lines.join("\n") }] };
    }

    return { content: [{ type: "text", text: `No contact found for ${phoneNumber}` }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
});

server.registerTool("quo_create_contact", {
  title: "Create Contact",
  description: "Create a new contact in Quo.",
  inputSchema: {
    firstName: z.string().optional().describe("First name"),
    lastName: z.string().optional().describe("Last name"),
    company: z.string().optional().describe("Company name"),
    role: z.string().optional().describe("Job title/role"),
    phoneNumber: z.string().optional().describe("Phone number in E.164 format"),
    email: z.string().optional().describe("Email address"),
  },
}, async ({ firstName, lastName, company, role, phoneNumber, email }) => {
  try {
    const defaultFields: Record<string, unknown> = {};
    if (firstName) defaultFields.firstName = firstName;
    if (lastName) defaultFields.lastName = lastName;
    if (company) defaultFields.company = company;
    if (role) defaultFields.role = role;
    if (phoneNumber) defaultFields.phoneNumbers = [{ name: "Mobile", value: phoneNumber }];
    if (email) defaultFields.emails = [{ name: "Work", value: email }];
    const result = await api("POST", "/contacts", { defaultFields });
    return { content: [{ type: "text", text: result }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: e.message }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
