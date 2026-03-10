#!/usr/bin/env node
/**
 * Permit Search MCP Server — read-only access to permit pipeline data.
 *
 * Env vars:
 *   PERMITS_MONGO_URI — defaults to mongodb://localhost:27017/permits
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { MongoClient, type Collection } from "mongodb";
import { z } from "zod";
import { writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const MONGO_URI = process.env.PERMITS_MONGO_URI || "mongodb://localhost:27017/permits";
const EXPORT_DIR = join(tmpdir(), "hive-exports");
mkdirSync(EXPORT_DIR, { recursive: true });

let client: MongoClient;
let permits: Collection;
let contractors: Collection;

async function connect() {
  if (!client) {
    client = new MongoClient(MONGO_URI);
    await client.connect();
    const db = client.db();
    permits = db.collection("permits");
    contractors = db.collection("contractors");
  }
}

const server = new McpServer({
  name: "hive-permits",
  version: "0.1.0",
});

// ── Search Permits ──────────────────────────────────────────────────────

server.registerTool(
  "permit_search",
  {
    title: "Search Permits",
    description:
      "Search building permit filings. Filter by city, date range, AI score, tier, keyword in description, or address. " +
      "Returns up to `limit` results sorted by filed date (newest first).",
    inputSchema: {
      city: z.string().optional().describe("City name (e.g. 'San Francisco', 'Oakland')"),
      query: z.string().optional().describe("Text search in description or address"),
      tier: z.string().optional().describe("Tier filter (e.g. 'A', 'B', 'C')"),
      min_ai_score: z.number().optional().describe("Minimum AI lead score (0-100)"),
      filed_after: z.string().optional().describe("Only permits filed after this date (YYYY-MM-DD)"),
      filed_before: z.string().optional().describe("Only permits filed before this date (YYYY-MM-DD)"),
      has_owner_contact: z.boolean().optional().describe("Only permits with owner phone/email from skip tracing"),
      limit: z.number().optional().default(20).describe("Max results (default 20, max 100)"),
    },
  },
  async (params) => {
    await connect();

    const filter: Record<string, unknown> = {};
    if (params.city) filter.city = { $regex: params.city, $options: "i" };
    if (params.tier) filter.tier = params.tier.toUpperCase();
    if (params.min_ai_score) filter.aiScore = { $gte: params.min_ai_score };
    if (params.query) {
      filter.$or = [
        { description: { $regex: params.query, $options: "i" } },
        { address: { $regex: params.query, $options: "i" } },
      ];
    }
    if (params.filed_after || params.filed_before) {
      const dateFilter: Record<string, string> = {};
      if (params.filed_after) dateFilter.$gte = params.filed_after;
      if (params.filed_before) dateFilter.$lte = params.filed_before;
      filter.filedDate = dateFilter;
    }
    if (params.has_owner_contact) {
      filter.$and = [
        { $or: [{ ownerPhone: { $exists: true, $ne: null } }, { ownerEmail: { $exists: true, $ne: null } }] },
      ];
    }

    const cap = Math.min(params.limit ?? 20, 100);
    const docs = await permits.find(filter).sort({ filedDate: -1 }).limit(cap).toArray();

    if (docs.length === 0) {
      return { content: [{ type: "text", text: "No permits found matching your criteria." }] };
    }

    const lines = docs.map((d) => {
      const parts = [
        `[${d.tier || "?"}] ${d.city} — ${d.address || "no address"}`,
        `  Filed: ${d.filedDate || "unknown"} | Valuation: $${(d.valuation || 0).toLocaleString()}`,
        `  Description: ${(d.description || "").slice(0, 150)}`,
        ...(d.aiScore != null ? [`  AI Score: ${d.aiScore} — ${d.aiClassification || ""}`] : []),
        ...(d.contractor ? [`  Contractor: ${d.contractor}`] : []),
        ...(d.ownerName
          ? [
              `  Owner: ${d.ownerName}${d.ownerPhone ? ` | ${d.ownerPhone}` : ""}${d.ownerEmail ? ` | ${d.ownerEmail}` : ""}`,
            ]
          : []),
        ...(d.assessedValue
          ? [
              `  Property: $${d.assessedValue.toLocaleString()} assessed | ${d.sqft || "?"} sqft | Built ${d.yearBuilt || "?"}`,
            ]
          : []),
      ];
      return parts.join("\n");
    });

    return { content: [{ type: "text", text: `Found ${docs.length} permits:\n\n${lines.join("\n\n")}` }] };
  },
);

// ── Permit Stats ────────────────────────────────────────────────────────

server.registerTool(
  "permit_stats",
  {
    title: "Permit Statistics",
    description: "Get summary statistics for permits — counts by city, tier, date range.",
    inputSchema: {
      filed_after: z.string().optional().describe("Only permits filed after this date (YYYY-MM-DD)"),
      filed_before: z.string().optional().describe("Only permits filed before this date (YYYY-MM-DD)"),
    },
  },
  async (params) => {
    await connect();

    const match: Record<string, unknown> = {};
    if (params.filed_after || params.filed_before) {
      const dateFilter: Record<string, string> = {};
      if (params.filed_after) dateFilter.$gte = params.filed_after;
      if (params.filed_before) dateFilter.$lte = params.filed_before;
      match.filedDate = dateFilter;
    }

    const [byCity, byTier, total] = await Promise.all([
      permits
        .aggregate([
          { $match: match },
          { $group: { _id: "$city", count: { $sum: 1 }, avgAiScore: { $avg: "$aiScore" } } },
          { $sort: { count: -1 } },
        ])
        .toArray(),
      permits
        .aggregate([{ $match: match }, { $group: { _id: "$tier", count: { $sum: 1 } } }, { $sort: { _id: 1 } }])
        .toArray(),
      permits.countDocuments(match),
    ]);

    const cityLines = byCity.map(
      (c) =>
        `  ${c._id}: ${c.count} permits${c.avgAiScore != null ? ` (avg AI score: ${Math.round(c.avgAiScore)})` : ""}`,
    );
    const tierLines = byTier.map((t) => `  Tier ${t._id || "unscored"}: ${t.count}`);

    const text = [`Total permits: ${total}`, "", "By city:", ...cityLines, "", "By tier:", ...tierLines].join("\n");

    return { content: [{ type: "text", text }] };
  },
);

// ── Search Contractors ──────────────────────────────────────────────────

server.registerTool(
  "permit_contractors",
  {
    title: "Search Contractors",
    description: "Search enriched contractor data from permit filings. Includes CSLB license info, phone, email.",
    inputSchema: {
      query: z.string().optional().describe("Search by contractor name"),
      has_phone: z.boolean().optional().describe("Only contractors with phone numbers"),
      has_email: z.boolean().optional().describe("Only contractors with email addresses"),
      limit: z.number().optional().default(20).describe("Max results (default 20, max 100)"),
    },
  },
  async (params) => {
    await connect();

    const filter: Record<string, unknown> = {};
    if (params.query) filter.displayName = { $regex: params.query, $options: "i" };
    if (params.has_phone) filter.phone = { $exists: true, $ne: "" };
    if (params.has_email) filter.email = { $exists: true, $ne: "" };

    const cap = Math.min(params.limit ?? 20, 100);
    const docs = await contractors.find(filter).limit(cap).toArray();

    if (docs.length === 0) {
      return { content: [{ type: "text", text: "No contractors found." }] };
    }

    const lines = docs.map((d) => {
      const parts = [
        `${d.displayName || d.name}`,
        ...(d.phone ? [`  Phone: ${d.phone}`] : []),
        ...(d.email ? [`  Email: ${d.email}`] : []),
        ...(d.website ? [`  Website: ${d.website}`] : []),
        ...(d.cslbLicenseNo
          ? [`  CSLB: #${d.cslbLicenseNo} (${d.cslbStatus || "unknown"}) — ${d.cslbClassifications || ""}`]
          : []),
        ...(d.permitIds?.length ? [`  Permits: ${d.permitIds.length}`] : []),
      ];
      return parts.join("\n");
    });

    return { content: [{ type: "text", text: `Found ${docs.length} contractors:\n\n${lines.join("\n\n")}` }] };
  },
);

// ── Export CSV ───────────────────────────────────────────────────────────

server.registerTool(
  "permit_export_csv",
  {
    title: "Export Permits to CSV",
    description:
      "Export permit search results as a CSV file. Returns the file path. " +
      "Use the same filters as permit_search. The CSV can then be shared via Slack file upload.",
    inputSchema: {
      city: z.string().optional().describe("City name filter"),
      query: z.string().optional().describe("Text search in description or address"),
      tier: z.string().optional().describe("Tier filter"),
      min_ai_score: z.number().optional().describe("Minimum AI lead score"),
      filed_after: z.string().optional().describe("Only permits filed after this date (YYYY-MM-DD)"),
      filed_before: z.string().optional().describe("Only permits filed before this date (YYYY-MM-DD)"),
      has_owner_contact: z.boolean().optional().describe("Only permits with owner contact info"),
      limit: z.number().optional().default(500).describe("Max rows (default 500, max 5000)"),
      filename: z.string().optional().describe("Custom filename (without .csv extension)"),
    },
  },
  async (params) => {
    await connect();

    const filter: Record<string, unknown> = {};
    if (params.city) filter.city = { $regex: params.city, $options: "i" };
    if (params.tier) filter.tier = params.tier.toUpperCase();
    if (params.min_ai_score) filter.aiScore = { $gte: params.min_ai_score };
    if (params.query) {
      filter.$or = [
        { description: { $regex: params.query, $options: "i" } },
        { address: { $regex: params.query, $options: "i" } },
      ];
    }
    if (params.filed_after || params.filed_before) {
      const dateFilter: Record<string, string> = {};
      if (params.filed_after) dateFilter.$gte = params.filed_after;
      if (params.filed_before) dateFilter.$lte = params.filed_before;
      filter.filedDate = dateFilter;
    }
    if (params.has_owner_contact) {
      filter.$and = [
        { $or: [{ ownerPhone: { $exists: true, $ne: null } }, { ownerEmail: { $exists: true, $ne: null } }] },
      ];
    }

    const cap = Math.min(params.limit ?? 500, 5000);
    const docs = await permits.find(filter).sort({ filedDate: -1 }).limit(cap).toArray();

    if (docs.length === 0) {
      return { content: [{ type: "text", text: "No permits found — nothing to export." }] };
    }

    const headers = [
      "City",
      "Address",
      "Filed Date",
      "Permit Number",
      "Description",
      "Valuation",
      "Tier",
      "AI Score",
      "AI Classification",
      "Contractor",
      "Applicant",
      "Owner Name",
      "Owner Phone",
      "Owner Email",
      "Assessed Value",
      "Year Built",
      "Sqft",
    ];

    const escCsv = (val: unknown): string => {
      const s = String(val ?? "");
      if (s.includes(",") || s.includes('"') || s.includes("\n")) {
        return `"${s.replace(/"/g, '""')}"`;
      }
      return s;
    };

    const rows = docs.map((d) =>
      [
        d.city,
        d.address,
        d.filedDate,
        d.permitNumber,
        d.description,
        d.valuation,
        d.tier,
        d.aiScore,
        d.aiClassification,
        d.contractor,
        d.applicant,
        d.ownerName,
        d.ownerPhone,
        d.ownerEmail,
        d.assessedValue,
        d.yearBuilt,
        d.sqft,
      ]
        .map(escCsv)
        .join(","),
    );

    const csv = [headers.join(","), ...rows].join("\n");
    const fname = (params.filename || `permits-${new Date().toISOString().slice(0, 10)}`) + ".csv";
    const fpath = join(EXPORT_DIR, fname);
    writeFileSync(fpath, csv, "utf-8");

    return {
      content: [
        {
          type: "text",
          text: `Exported ${docs.length} permits to CSV.\nFile: ${fpath}\nSize: ${(csv.length / 1024).toFixed(1)} KB`,
        },
      ],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
