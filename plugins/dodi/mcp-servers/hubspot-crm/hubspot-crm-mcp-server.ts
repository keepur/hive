#!/usr/bin/env node
/**
 * HubSpot CRM MCP Server — read/write CRM operations via HubSpot v3 API.
 *
 * Env vars:
 *   HUBSPOT_API_KEY — required, private app access token with write scopes
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { HubSpotApiClient } from "./hubspot-api-client.js";

const API_KEY = process.env.HUBSPOT_API_KEY ?? "";

if (!API_KEY) {
  process.stderr.write("hubspot-crm: HUBSPOT_API_KEY required\n");
  process.exit(1);
}

const client = new HubSpotApiClient(API_KEY);

const server = new McpServer({
  name: "hubspot-crm",
  version: "0.1.0",
});

// ── Tool: hubspot_find_contact ──────────────────────────────────────────────

server.registerTool(
  "hubspot_find_contact",
  {
    title: "Find HubSpot Contact",
    description:
      "Search for a contact in HubSpot by email or name. Returns the first matching contact with all available details.",
    inputSchema: {
      query: z.string().describe("Email address or name to search for"),
    },
  },
  async ({ query }) => {
    try {
      const contact = await client.findContact(query);

      if (!contact) {
        return { content: [{ type: "text", text: `No contact found for "${query}"` }] };
      }

      const p = contact.properties;
      const lines: string[] = [`Contact ${contact.id}`];
      const name = [p.firstname, p.lastname].filter(Boolean).join(" ");
      if (name) lines.push(`- Name: ${name}`);
      if (p.email) lines.push(`- Email: ${p.email}`);
      if (p.phone) lines.push(`- Phone: ${p.phone}`);
      if (p.company) lines.push(`- Company: ${p.company}`);
      if (p.jobtitle) lines.push(`- Job Title: ${p.jobtitle}`);
      if (p.lifecyclestage) lines.push(`- Lifecycle: ${p.lifecyclestage}`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Tool: hubspot_get_contact ────────────────────────────────────────────────

server.registerTool(
  "hubspot_get_contact",
  {
    title: "Get HubSpot Contact by ID",
    description:
      "Fetch a contact's current details from HubSpot by their record ID. Use this when you already have a contact ID and need fresh data.",
    inputSchema: {
      id: z.string().describe("HubSpot contact ID"),
    },
  },
  async ({ id }) => {
    try {
      const contact = await client.getContact(id);
      const p = contact.properties;
      const lines: string[] = [`Contact ${contact.id}`];
      const name = [p.firstname, p.lastname].filter(Boolean).join(" ");
      if (name) lines.push(`- Name: ${name}`);
      if (p.email) lines.push(`- Email: ${p.email}`);
      if (p.phone) lines.push(`- Phone: ${p.phone}`);
      if (p.company) lines.push(`- Company: ${p.company}`);
      if (p.jobtitle) lines.push(`- Job Title: ${p.jobtitle}`);
      if (p.lifecyclestage) lines.push(`- Lifecycle: ${p.lifecyclestage}`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Tool: hubspot_get_deal ──────────────────────────────────────────────────

server.registerTool(
  "hubspot_get_deal",
  {
    title: "Get HubSpot Deal by ID",
    description:
      "Fetch a deal's current details from HubSpot by its record ID. Use this when you already have a deal ID and need fresh data.",
    inputSchema: {
      id: z.string().describe("HubSpot deal ID"),
    },
  },
  async ({ id }) => {
    try {
      const deal = await client.getDeal(id);
      const p = deal.properties;
      const lines: string[] = [`Deal ${deal.id}`];
      if (p.dealname) lines.push(`- Name: ${p.dealname}`);
      if (p.dealstage) lines.push(`- Stage: ${p.dealstage}`);
      if (p.pipeline) lines.push(`- Pipeline: ${p.pipeline}`);
      if (p.amount) lines.push(`- Amount: $${p.amount}`);
      if (p.closedate) lines.push(`- Close Date: ${p.closedate}`);
      if (p.hubspot_owner_id) lines.push(`- Owner: ${p.hubspot_owner_id}`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Tool: hubspot_find_deal ─────────────────────────────────────────────────

server.registerTool(
  "hubspot_find_deal",
  {
    title: "Find HubSpot Deal",
    description:
      "Search for deals in HubSpot by name. Returns up to 10 matching deals sorted by creation date (newest first).",
    inputSchema: {
      query: z.string().describe("Deal name to search for"),
    },
  },
  async ({ query }) => {
    try {
      const deals = await client.findDeal(query);

      if (deals.length === 0) {
        return { content: [{ type: "text", text: `No deals found for "${query}"` }] };
      }

      const lines = deals.map((deal) => {
        const p = deal.properties;
        const parts: string[] = [`Deal ${deal.id}: ${p.dealname ?? "(unnamed)"}`];
        if (p.dealstage) parts.push(`  Stage: ${p.dealstage}`);
        if (p.amount) parts.push(`  Amount: $${p.amount}`);
        if (p.closedate) parts.push(`  Close: ${p.closedate}`);
        return parts.join("\n");
      });

      return { content: [{ type: "text", text: `Found ${deals.length} deals:\n\n${lines.join("\n\n")}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Tool: hubspot_list_deals ─────────────────────────────────────────────────

server.registerTool(
  "hubspot_list_deals",
  {
    title: "List HubSpot Deals",
    description:
      "List deals from the Sales Pipeline with optional filters. " +
      "Filter by stage(s) and/or close date range to get a complete list of matching deals. " +
      "Stage IDs: S0 Prospect (appointmentscheduled), S1 Meeting (qualifiedtobuy), " +
      "S2 Discovery (15520138), S3 Evaluation (15520119), S4 Proposal (decisionmakerboughtin), " +
      "S5 Invoice (63682726), Sales Nurture (149783667), Closed won (closedwon), Closed lost (closedlost).",
    inputSchema: {
      stages: z
        .array(z.string())
        .optional()
        .describe('Deal stage IDs to filter by (e.g. ["15520138", "15520119", "decisionmakerboughtin", "149783667"])'),
      closeDateAfter: z
        .string()
        .optional()
        .describe("Only deals with close date on or after this date (ISO format, e.g. 2026-03-01)"),
      closeDateBefore: z
        .string()
        .optional()
        .describe("Only deals with close date on or before this date (ISO format, e.g. 2026-05-31)"),
      limit: z.number().optional().default(100).describe("Max deals to return (default 100)"),
    },
  },
  async ({ stages, closeDateAfter, closeDateBefore, limit }) => {
    try {
      const deals = await client.listDeals({ stages, closeDateAfter, closeDateBefore, limit });

      if (deals.length === 0) {
        return { content: [{ type: "text", text: "No deals found matching those filters." }] };
      }

      const lines = deals.map((deal) => {
        const p = deal.properties;
        const parts: string[] = [`Deal ${deal.id}: ${p.dealname ?? "(unnamed)"}`];
        if (p.dealstage) parts.push(`  Stage: ${p.dealstage}`);
        if (p.amount) parts.push(`  Amount: $${p.amount}`);
        if (p.closedate) parts.push(`  Close: ${p.closedate}`);
        if (p.hubspot_owner_id) parts.push(`  Owner: ${p.hubspot_owner_id}`);
        return parts.join("\n");
      });

      return {
        content: [{ type: "text", text: `${deals.length} deals:\n\n${lines.join("\n\n")}` }],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Tool: hubspot_create_contact ────────────────────────────────────────────

server.registerTool(
  "hubspot_create_contact",
  {
    title: "Create HubSpot Contact",
    description: "Create a new contact in HubSpot CRM. Optionally associate with an existing deal.",
    inputSchema: {
      email: z.string().describe("Email address (required)"),
      firstname: z.string().optional().describe("First name"),
      lastname: z.string().optional().describe("Last name"),
      phone: z.string().optional().describe("Phone number"),
      company: z.string().optional().describe("Company name"),
      jobtitle: z.string().optional().describe("Job title"),
      lifecyclestage: z.string().optional().describe("Lifecycle stage (e.g. lead, opportunity, customer)"),
      associateDealId: z.string().optional().describe("Deal ID to associate this contact with"),
    },
  },
  async ({ email, firstname, lastname, phone, company, jobtitle, lifecyclestage, associateDealId }) => {
    try {
      const properties: Record<string, string> = { email };
      if (firstname) properties.firstname = firstname;
      if (lastname) properties.lastname = lastname;
      if (phone) properties.phone = phone;
      if (company) properties.company = company;
      if (jobtitle) properties.jobtitle = jobtitle;
      if (lifecyclestage) properties.lifecyclestage = lifecyclestage;

      const result = await client.createContact(properties);

      if (associateDealId) {
        await client.associate("contact", result.id, "deal", associateDealId);
      }

      const lines: string[] = [`Created contact ${result.id}`];
      const name = [firstname, lastname].filter(Boolean).join(" ");
      if (name) lines.push(`- Name: ${name}`);
      lines.push(`- Email: ${email}`);
      if (phone) lines.push(`- Phone: ${phone}`);
      if (company) lines.push(`- Company: ${company}`);
      if (jobtitle) lines.push(`- Job Title: ${jobtitle}`);
      if (lifecyclestage) lines.push(`- Lifecycle: ${lifecyclestage}`);
      if (associateDealId) lines.push(`- Associated with deal ${associateDealId}`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Tool: hubspot_update_contact ────────────────────────────────────────────

server.registerTool(
  "hubspot_update_contact",
  {
    title: "Update HubSpot Contact",
    description: "Update an existing contact's properties in HubSpot CRM.",
    inputSchema: {
      id: z.string().describe("HubSpot contact ID"),
      properties: z
        .string()
        .describe('JSON object of properties to update (e.g. {"firstname": "John", "lifecyclestage": "customer"})'),
    },
  },
  async ({ id, properties }) => {
    try {
      const parsed = JSON.parse(properties) as Record<string, string>;
      await client.updateContact(id, parsed);

      return { content: [{ type: "text", text: `Contact ${id} updated` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Tool: hubspot_create_deal ───────────────────────────────────────────────

server.registerTool(
  "hubspot_create_deal",
  {
    title: "Create HubSpot Deal",
    description:
      "Create a new deal in the Sales Pipeline. Optionally associate with an existing contact. Valid stages: S0 - Prospect (appointmentscheduled), S1 - Meeting (qualifiedtobuy), S2 - Discovery (15520138), S3 - Evaluation (15520119), S4 - Proposal (decisionmakerboughtin), S5 - Invoice (63682726), Sales Nurture (149783667), Closed won (closedwon), Closed lost (closedlost).",
    inputSchema: {
      dealname: z.string().describe("Deal name (required)"),
      dealstage: z.string().describe("Deal stage ID — use the ID in parentheses from the tool description"),
      amount: z.string().optional().describe("Deal amount"),
      closedate: z.string().optional().describe("Expected close date (ISO format)"),
      hubspot_owner_id: z.string().optional().describe("HubSpot owner ID"),
      associateContactId: z.string().optional().describe("Contact ID to associate this deal with"),
    },
  },
  async ({ dealname, dealstage, amount, closedate, hubspot_owner_id, associateContactId }) => {
    try {
      const properties: Record<string, string> = { dealname, pipeline: "default", dealstage };
      if (amount) properties.amount = amount;
      if (closedate) properties.closedate = closedate;
      if (hubspot_owner_id) properties.hubspot_owner_id = hubspot_owner_id;

      const result = await client.createDeal(properties);

      if (associateContactId) {
        await client.associate("deal", result.id, "contact", associateContactId);
      }

      const lines: string[] = [`Created deal ${result.id}`];
      lines.push(`- Name: ${dealname}`);
      lines.push(`- Stage: ${dealstage}`);
      lines.push(`- Pipeline: Sales Pipeline`);
      if (amount) lines.push(`- Amount: $${amount}`);
      if (closedate) lines.push(`- Close Date: ${closedate}`);
      if (hubspot_owner_id) lines.push(`- Owner: ${hubspot_owner_id}`);
      if (associateContactId) lines.push(`- Associated with contact ${associateContactId}`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Tool: hubspot_update_deal ───────────────────────────────────────────────

server.registerTool(
  "hubspot_update_deal",
  {
    title: "Update HubSpot Deal",
    description: "Update an existing deal's properties in HubSpot CRM.",
    inputSchema: {
      id: z.string().describe("HubSpot deal ID"),
      properties: z
        .string()
        .describe('JSON object of properties to update (e.g. {"dealstage": "closedwon", "amount": "5000"})'),
    },
  },
  async ({ id, properties }) => {
    try {
      const parsed = JSON.parse(properties) as Record<string, string>;
      await client.updateDeal(id, parsed);

      return { content: [{ type: "text", text: `Deal ${id} updated` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Tool: hubspot_create_note ───────────────────────────────────────────────

server.registerTool(
  "hubspot_create_note",
  {
    title: "Create HubSpot Note",
    description: "Create a note in HubSpot CRM. Optionally associate with a contact and/or deal.",
    inputSchema: {
      body: z.string().describe("Note body text (required)"),
      contactId: z.string().optional().describe("Contact ID to associate this note with"),
      dealId: z.string().optional().describe("Deal ID to associate this note with"),
    },
  },
  async ({ body, contactId, dealId }) => {
    try {
      const result = await client.createNote(body);

      if (contactId) {
        await client.associate("note", result.id, "contact", contactId);
      }
      if (dealId) {
        await client.associate("note", result.id, "deal", dealId);
      }

      const lines: string[] = [`Created note ${result.id}`];
      if (contactId) lines.push(`- Associated with contact ${contactId}`);
      if (dealId) lines.push(`- Associated with deal ${dealId}`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Tool: hubspot_create_task ───────────────────────────────────────────────

server.registerTool(
  "hubspot_create_task",
  {
    title: "Create HubSpot Task",
    description: "Create a task in HubSpot CRM. Optionally associate with a contact and/or deal.",
    inputSchema: {
      subject: z.string().describe("Task subject (required)"),
      body: z.string().optional().describe("Task body/description"),
      status: z
        .enum(["NOT_STARTED", "IN_PROGRESS", "COMPLETED"])
        .optional()
        .default("NOT_STARTED")
        .describe("Task status"),
      priority: z.enum(["LOW", "MEDIUM", "HIGH"]).optional().describe("Task priority"),
      dueDate: z.string().optional().describe("Due date (ISO format)"),
      hubspot_owner_id: z.string().optional().describe("HubSpot owner ID"),
      contactId: z.string().optional().describe("Contact ID to associate this task with"),
      dealId: z.string().optional().describe("Deal ID to associate this task with"),
    },
  },
  async ({ subject, body, status, priority, dueDate, hubspot_owner_id, contactId, dealId }) => {
    try {
      const properties: Record<string, string> = {
        hs_task_subject: subject,
        hs_task_status: status,
      };
      if (body) properties.hs_task_body = body;
      if (priority) properties.hs_task_priority = priority;
      if (dueDate) properties.hs_timestamp = dueDate;
      if (hubspot_owner_id) properties.hubspot_owner_id = hubspot_owner_id;

      const result = await client.createTask(properties);

      if (contactId) {
        await client.associate("task", result.id, "contact", contactId);
      }
      if (dealId) {
        await client.associate("task", result.id, "deal", dealId);
      }

      const lines: string[] = [`Created task ${result.id}`];
      lines.push(`- Subject: ${subject}`);
      lines.push(`- Status: ${status}`);
      if (priority) lines.push(`- Priority: ${priority}`);
      if (dueDate) lines.push(`- Due: ${dueDate}`);
      if (hubspot_owner_id) lines.push(`- Owner: ${hubspot_owner_id}`);
      if (contactId) lines.push(`- Associated with contact ${contactId}`);
      if (dealId) lines.push(`- Associated with deal ${dealId}`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Tool: hubspot_update_task ───────────────────────────────────────────────

server.registerTool(
  "hubspot_update_task",
  {
    title: "Update HubSpot Task",
    description: "Update an existing task's properties in HubSpot CRM.",
    inputSchema: {
      id: z.string().describe("HubSpot task ID"),
      properties: z.string().describe('JSON object of properties to update (e.g. {"hs_task_status": "COMPLETED"})'),
    },
  },
  async ({ id, properties }) => {
    try {
      const parsed = JSON.parse(properties) as Record<string, string>;
      await client.updateTask(id, parsed);

      return { content: [{ type: "text", text: `Task ${id} updated` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Tool: hubspot_get_activities ─────────────────────────────────────────

server.registerTool(
  "hubspot_get_activities",
  {
    title: "Get HubSpot Activities",
    description:
      "Get all activities (emails, notes, tasks, calls, meetings) associated with a specific contact or deal by ID. " +
      "Returns a chronological timeline of all engagement history. " +
      "Use this instead of semantic search when you have a specific record ID and need its full activity history.",
    inputSchema: {
      object_type: z.enum(["contact", "deal"]).describe("Record type — 'contact' or 'deal'"),
      object_id: z.string().describe("HubSpot record ID"),
      limit: z.number().optional().default(50).describe("Max activities to return (default 50)"),
    },
  },
  async ({ object_type, object_id, limit }) => {
    try {
      const activities = await client.getActivities(object_type, object_id, { limit });

      if (activities.length === 0) {
        return { content: [{ type: "text", text: `No activities found for ${object_type} ${object_id}` }] };
      }

      const lines = activities.map((a) => {
        const date = a.timestamp
          ? new Date(a.timestamp).toLocaleString("en-US", { timeZone: "America/Los_Angeles" })
          : "unknown date";
        return `[${date}] ${a.summary}`;
      });

      return {
        content: [
          {
            type: "text",
            text: `${activities.length} activities for ${object_type} ${object_id}:\n\n${lines.join("\n\n")}`,
          },
        ],
      };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Tool: hubspot_find_owner ─────────────────────────────────────────────────

server.registerTool(
  "hubspot_find_owner",
  {
    title: "Find HubSpot Owner",
    description:
      "Look up a HubSpot owner (team member) by name or email. Returns matching owners with their IDs, which you can use in hubspot_owner_id fields when creating deals or tasks. Searches all owners and filters by your query.",
    inputSchema: {
      query: z.string().describe("Name or email to search for (e.g. 'Corey', 'corey@dodihome.com')"),
    },
  },
  async ({ query }) => {
    try {
      const owners = await client.listOwners();
      const q = query.toLowerCase();

      const matches = owners.filter((o) => {
        const full = `${o.firstName} ${o.lastName}`.toLowerCase();
        return full.includes(q) || o.email.toLowerCase().includes(q);
      });

      if (matches.length === 0) {
        return { content: [{ type: "text", text: `No owner found matching "${query}"` }] };
      }

      const lines = matches.map((o) => `Owner ${o.id}: ${o.firstName} ${o.lastName} (${o.email})`);

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Tool: hubspot_associate ─────────────────────────────────────────────────

server.registerTool(
  "hubspot_associate",
  {
    title: "Associate HubSpot Records",
    description:
      "Create an association between two HubSpot CRM records (e.g. link a contact to a deal, or a note to a contact).",
    inputSchema: {
      fromType: z.enum(["contact", "deal", "note", "task"]).describe("Source record type"),
      fromId: z.string().describe("Source record ID"),
      toType: z.enum(["contact", "deal", "note", "task"]).describe("Target record type"),
      toId: z.string().describe("Target record ID"),
    },
  },
  async ({ fromType, fromId, toType, toId }) => {
    try {
      await client.associate(fromType, fromId, toType, toId);

      return { content: [{ type: "text", text: `Associated ${fromType} ${fromId} with ${toType} ${toId}` }] };
    } catch (e: any) {
      return { content: [{ type: "text", text: e.message }], isError: true };
    }
  },
);

// ── Connect and run ─────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
