#!/usr/bin/env node

/**
 * Resend MCP Server — Email sending via Resend API.
 *
 * Sends from a fixed bot address with configurable reply-to per rep.
 * Auto-CCs configured sales address and BCCs HubSpot for CRM logging.
 *
 * Env vars:
 *   RESEND_API_KEY      — required, from Resend dashboard
 *   RESEND_FROM_ADDRESS — from address (configured in .env)
 *   RESEND_DEFAULT_CC   — default CC address (configured in .env)
 *   HUBSPOT_BCC         — HubSpot BCC address for outgoing email logging
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const API_KEY = process.env.RESEND_API_KEY ?? "";
const FROM_ADDRESS = process.env.RESEND_FROM_ADDRESS ?? "";
const DEFAULT_CC = process.env.RESEND_DEFAULT_CC ?? "";
const HUBSPOT_BCC = process.env.HUBSPOT_BCC ?? "";

const server = new McpServer({
  name: "hive-resend",
  version: "0.1.0",
});

// ── Send Email ─────────────────────────────────────────────────────────

server.registerTool("send_email", {
  title: "Send Email",
  description: `Send an email via Resend. Emails are sent from ${FROM_ADDRESS}. ` +
    `Always auto-CCs ${DEFAULT_CC} for sales visibility. ` +
    `Set reply_to to the assigned rep's email so customer replies go to the right person.`,
  inputSchema: {
    to: z.union([z.string(), z.array(z.string())]).describe("Recipient email address(es)"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Email body (plain text)"),
    html: z.string().optional().describe("Email body (HTML) — if provided, used instead of plain text for rich formatting"),
    reply_to: z.string().optional().describe("Reply-To address (e.g. the assigned rep's email). Customer replies go here."),
    cc: z.union([z.string(), z.array(z.string())]).optional().describe(`Additional CC addresses. ${DEFAULT_CC} is always included automatically.`),
  },
}, async ({ to, subject, body, html, reply_to, cc }) => {
  if (!API_KEY) {
    return { content: [{ type: "text", text: "Resend API key not configured." }], isError: true };
  }

  try {
    // Build CC list — include default CC if configured
    const ccList = new Set<string>();
    if (DEFAULT_CC) ccList.add(DEFAULT_CC);
    if (cc) {
      const extras = Array.isArray(cc) ? cc : [cc];
      for (const addr of extras) ccList.add(addr);
    }

    // Build BCC list — HubSpot logging
    const bccList: string[] = [];
    if (HUBSPOT_BCC) bccList.push(HUBSPOT_BCC);

    const payload: Record<string, unknown> = {
      from: FROM_ADDRESS,
      to: Array.isArray(to) ? to : [to],
      subject,
      ...(ccList.size > 0 ? { cc: [...ccList] } : {}),
      ...(bccList.length > 0 ? { bcc: bccList } : {}),
      ...(reply_to ? { reply_to } : {}),
      ...(html ? { html } : { text: body }),
    };

    // Also include plain text as fallback when HTML is provided
    if (html) {
      payload.text = body;
    }

    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    const result = await res.text();

    if (!res.ok) {
      return { content: [{ type: "text", text: `Resend API error ${res.status}: ${result}` }], isError: true };
    }

    const data = JSON.parse(result);
    const toDisplay = Array.isArray(to) ? to.join(", ") : to;
    const replyDisplay = reply_to ? ` (reply-to: ${reply_to})` : "";
    const summary = [
      `Email sent successfully`,
      `  To: ${toDisplay}`,
      `  From: ${FROM_ADDRESS}${replyDisplay}`,
      `  Subject: ${subject}`,
      `  CC: ${[...ccList].join(", ")}`,
      ...(HUBSPOT_BCC ? [`  HubSpot: logged via BCC`] : []),
      `  Resend ID: ${data.id}`,
    ].join("\n");

    return { content: [{ type: "text", text: summary }] };
  } catch (e: any) {
    return { content: [{ type: "text", text: `Email send failed: ${e.message}` }], isError: true };
  }
});

const transport = new StdioServerTransport();
await server.connect(transport);
