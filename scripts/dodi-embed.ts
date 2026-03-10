#!/usr/bin/env npx tsx

/**
 * dodi_v2 Operational Data Embedding Pipeline — Local Ollama + Qdrant
 *
 * Reads from local MongoDB (restored from Atlas production), builds embedding text
 * for each record, calls local Ollama (bge-large) to generate vector embeddings,
 * and upserts them into local Qdrant.
 *
 * Source: local MongoDB `dodi` database (mongodump/restore from Atlas `production`)
 * Target: Qdrant collections — persons, projects, designs, quotes, orders, jobs,
 *         operational_tasks, parts, cases
 *
 * Usage:
 *   npx tsx scripts/dodi-embed.ts [options]
 *
 * Options:
 *   --dry-run       Preview counts per object type, skip embedding and upsert
 *   --reembed       Ignore watermarks, process all records
 *   --objects TYPE   Only process the specified object type (e.g., --objects project)
 *
 * Env vars:
 *   MONGODB_DODI_URI   — Local MongoDB (default: mongodb://localhost:27017/dodi)
 *   OLLAMA_URL         — Ollama API (default: http://localhost:11434)
 *   QDRANT_URL         — Qdrant API (default: http://localhost:6333)
 *   EMBED_MODEL        — Ollama model (default: bge-large)
 *   EMBED_DIMS         — Embedding dimensions (default: 1024)
 */

import { MongoClient, type Db } from "mongodb";
import { QdrantClient } from "@qdrant/js-client-rest";
import { createHash } from "node:crypto";

// ── Config ──────────────────────────────────────────────────────────────────

const EMBED_MODEL = process.env.EMBED_MODEL ?? "bge-large";
const EMBED_DIMS = parseInt(process.env.EMBED_DIMS ?? "1024", 10);
const EMBED_BATCH_SIZE = 100;
const OLLAMA_URL = process.env.OLLAMA_URL ?? "http://localhost:11434";
const QDRANT_URL = process.env.QDRANT_URL ?? "http://localhost:6333";
const MONGODB_DODI_URI = process.env.MONGODB_DODI_URI ?? "mongodb://localhost:27017/dodi";

const QDRANT_UPSERT_BATCH = 100;
const OLLAMA_MAX_RETRIES = 5;
const OLLAMA_RETRY_DELAY_MS = 5000;
const EMBED_TEXT_MAX = 1000;

// UUID v5 namespace (DNS namespace UUID)
const UUID_NAMESPACE = "6ba7b810-9dad-11d1-80b4-00c04fd430c8";

// ── CLI Args ────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const reembed = args.includes("--reembed");
const objectsIdx = args.indexOf("--objects");
const objectsFilter = objectsIdx !== -1 ? args[objectsIdx + 1] : null;

// ── UUID v5 (deterministic point IDs) ───────────────────────────────────────

function uuidV5(name: string, namespace: string): string {
  const nsBytes = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1")
    .update(nsBytes)
    .update(Buffer.from(name, "utf-8"))
    .digest();

  hash[6] = (hash[6]! & 0x0f) | 0x50; // version 5
  hash[8] = (hash[8]! & 0x3f) | 0x80; // variant RFC 4122

  const hex = hash.subarray(0, 16).toString("hex");
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join("-");
}

function pointId(objectType: string, dodiId: string): string {
  return uuidV5(`${objectType}:${dodiId}`, UUID_NAMESPACE);
}

// ── Ollama Embedding ────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function embedBatch(texts: string[]): Promise<number[][]> {
  for (let attempt = 1; attempt <= OLLAMA_MAX_RETRIES; attempt++) {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model: EMBED_MODEL, input: texts }),
      });
      if (!res.ok) {
        const body = await res.text();
        throw new Error(`Ollama ${res.status}: ${body}`);
      }
      const data = (await res.json()) as { embeddings: number[][] };
      return data.embeddings;
    } catch (err: any) {
      if (attempt < OLLAMA_MAX_RETRIES) {
        const delay = OLLAMA_RETRY_DELAY_MS * attempt;
        console.warn(`  Ollama attempt ${attempt} failed: ${err.message} — retrying in ${delay}ms`);
        await sleep(delay);
      } else {
        throw err;
      }
    }
  }
  throw new Error("unreachable");
}

// ── Helpers ─────────────────────────────────────────────────────────────────

function truncate(text: string | null | undefined, max = EMBED_TEXT_MAX): string {
  if (!text) return "";
  return text.length > max ? text.slice(0, max) : text;
}

function stripHtml(text: string | null | undefined): string {
  if (!text) return "";
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#x27;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function elapsed(startMs: number): string {
  const secs = ((Date.now() - startMs) / 1000).toFixed(1);
  return `${secs}s`;
}

function formatAddress(addr: any): string {
  if (!addr) return "";
  const parts: string[] = [];
  if (addr.street1) parts.push(addr.street1);
  if (addr.vicinity) {
    const v = addr.vicinity;
    const loc = [v.city, v.state].filter(Boolean).join(", ");
    if (loc) parts.push(loc);
    if (v.zipcode) parts.push(v.zipcode);
  }
  return parts.join(", ");
}

function fmtDate(d: any): string {
  if (!d) return "";
  try {
    return new Date(d).toISOString().split("T")[0]!;
  } catch {
    return "";
  }
}

function fmtMoney(amount: any): string {
  if (amount == null) return "";
  const n = typeof amount === "number" ? amount : parseFloat(amount);
  if (isNaN(n)) return "";
  return `$${n.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

// ── Enrichment Loaders ──────────────────────────────────────────────────────

/** Map of project _id → project name + homeowner name */
interface ProjectInfo {
  name: string;
  homeowner?: string;
  address?: string;
  state?: string;
}

async function loadProjectMap(db: Db): Promise<Map<string, ProjectInfo>> {
  const map = new Map<string, ProjectInfo>();
  const cursor = db.collection("projects").find(
    {},
    { projection: { _id: 1, name: 1, persons: 1, address: 1, state: 1 } },
  );
  for await (const doc of cursor) {
    const homeowner = doc.persons?.find(
      (p: any) => p.roles?.includes("project.homeowner"),
    );
    map.set(doc._id, {
      name: doc.name ?? "",
      homeowner: homeowner?.name,
      address: formatAddress(doc.address),
      state: doc.state,
    });
  }
  console.log(`  Project map loaded: ${map.size} projects`);
  return map;
}

// ── Text Builders ───────────────────────────────────────────────────────────

function personText(doc: any): string {
  const parts = [`Person: ${doc.name || "Unknown"}`];
  if (doc.email) parts.push(`Email: ${doc.email}`);
  if (doc.phone?.number) parts.push(`Phone: ${doc.phone.number}`);
  if (doc.natures?.length) parts.push(`Roles: ${doc.natures.join(", ")}`);
  return parts.join(". ") + ".";
}

function projectText(doc: any): string {
  const parts = [`Project: ${doc.name || "Unknown"}`];
  if (doc.projectType) parts.push(`Type: ${doc.projectType}`);
  if (doc.state) parts.push(`Status: ${doc.state}`);
  const addr = formatAddress(doc.address);
  if (addr) parts.push(`Address: ${addr}`);
  // Extract people
  const homeowner = doc.persons?.find((p: any) => p.roles?.includes("project.homeowner"));
  const designer = doc.persons?.find((p: any) => p.roles?.includes("project.designer") || p.roles?.includes("project.owner"));
  if (homeowner?.name) parts.push(`Customer: ${homeowner.name}`);
  if (designer?.name) parts.push(`Designer: ${designer.name}`);
  if (doc.createdAt) parts.push(`Created: ${fmtDate(doc.createdAt)}`);
  return parts.join(". ") + ".";
}

function designText(doc: any): string {
  const parts = [`Design: ${doc.name || "Unknown"}`];
  if (doc.state) parts.push(`Status: ${doc.state}`);
  // Extract useful metadata from spec, skip heavy geometry
  const spec = doc.spec;
  if (spec) {
    if (spec.style) parts.push(`Style: ${spec.style}`);
    if (spec.roomShape) parts.push(`Room shape: ${spec.roomShape}`);
    if (spec.dimension) {
      const d = spec.dimension;
      parts.push(`Room dimensions: ${d.x}" × ${d.y}" × ${d.z}"`);
    }
    if (spec.buildSpec) {
      const bs = spec.buildSpec;
      if (bs.boxMaterial) parts.push(`Box material: ${bs.boxMaterial}`);
      if (bs.drawerBox) parts.push(`Drawer box: ${bs.drawerBox}`);
      if (bs.hardwareBrand) parts.push(`Hardware: ${bs.hardwareBrand}`);
    }
    // Extract unique materials from elements (without the heavy geometry)
    const materials = new Set<string>();
    const cabinetModels = new Set<string>();
    for (const run of spec.runs ?? []) {
      for (const el of run.elements ?? []) {
        if (el.material?.name) materials.add(el.material.name);
        if (el.model) cabinetModels.add(el.model);
      }
    }
    if (materials.size > 0) parts.push(`Materials: ${[...materials].join(", ")}`);
    if (cabinetModels.size > 0) parts.push(`Cabinets: ${[...cabinetModels].join(", ")}`);
    // Appliances
    if (spec.appliances?.length) {
      const appModels = spec.appliances.map((a: any) => a.model).filter(Boolean);
      if (appModels.length) parts.push(`Appliances: ${appModels.join(", ")}`);
    }
  }
  return parts.join(". ") + ".";
}

function quoteText(doc: any, projectMap: Map<string, ProjectInfo>): string {
  const parts = [`Quote #${doc.number || doc._id}`];
  if (doc.description) parts.push(`Description: ${truncate(doc.description, 300)}`);
  // Resolve project name
  const proj = projectMap.get(doc.project);
  if (proj) parts.push(`Project: ${proj.name}`);
  if (doc.customer?.name) parts.push(`Customer: ${doc.customer.name}`);
  if (doc.total != null) parts.push(`Total: ${fmtMoney(doc.total)}`);
  if (doc.state) parts.push(`Status: ${doc.state}`);
  // Summarize sections/line items
  const lineCount = doc.sections?.reduce(
    (sum: number, s: any) => sum + (s.lines?.length ?? 0),
    0,
  ) ?? 0;
  if (lineCount > 0) parts.push(`Line items: ${lineCount}`);
  if (doc.createdAt) parts.push(`Date: ${fmtDate(doc.createdAt)}`);
  return parts.join(". ") + ".";
}

function orderText(doc: any, projectMap: Map<string, ProjectInfo>): string {
  const parts = [`Order #${doc.number || doc._id}`];
  // Resolve project
  const projId = doc.scope ?? doc.meta?.project;
  const proj = projId ? projectMap.get(projId) : undefined;
  if (proj) parts.push(`Project: ${proj.name}`);
  if (doc.customer?.name) parts.push(`Customer: ${doc.customer.name}`);
  if (doc.total != null) parts.push(`Total: ${fmtMoney(doc.total)}`);
  if (doc.state) parts.push(`Status: ${doc.state}`);
  if (doc.type) parts.push(`Type: ${doc.type}`);
  if (doc.lineItems?.length) parts.push(`Line items: ${doc.lineItems.length}`);
  if (doc.paymentInfo?.method) parts.push(`Payment: ${doc.paymentInfo.method}`);
  if (doc.createdAt) parts.push(`Date: ${fmtDate(doc.createdAt)}`);
  return parts.join(". ") + ".";
}

function jobText(doc: any, projectMap: Map<string, ProjectInfo>): string {
  const parts = [`Job #${doc.number || doc._id}`];
  // Resolve project
  const proj = doc.project ? projectMap.get(doc.project) : undefined;
  if (proj) parts.push(`Project: ${proj.name}`);
  if (doc.state) parts.push(`Status: ${doc.state}`);
  // Summarize sections (design names) without line item detail
  const sectionNames = doc.sections
    ?.map((s: any) => s.name || s.description)
    .filter(Boolean) ?? [];
  if (sectionNames.length) parts.push(`Sections: ${sectionNames.join(", ")}`);
  if (doc.createdAt) parts.push(`Date: ${fmtDate(doc.createdAt)}`);
  return parts.join(". ") + ".";
}

function operationalTaskText(doc: any): string {
  const parts = [`Task: ${doc.name || "(untitled)"}`];
  if (doc.type) parts.push(`Type: ${doc.type}`);
  if (doc.state) parts.push(`Status: ${doc.state}`);
  // References carry denormalized project/job names
  const projRef = doc.references?.find((r: any) => r.type === "project");
  const jobRef = doc.references?.find((r: any) => r.type === "job");
  if (projRef?.name) parts.push(`Project: ${projRef.name}`);
  if (jobRef?.name) parts.push(`Job: ${jobRef.name}`);
  if (doc.data?.result) parts.push(`Result: ${doc.data.result}`);
  if (doc.completedAt) parts.push(`Completed: ${fmtDate(doc.completedAt)}`);
  else if (doc.createdAt) parts.push(`Created: ${fmtDate(doc.createdAt)}`);
  return parts.join(". ") + ".";
}

function partText(doc: any): string {
  const parts = [`Part: ${doc.name || doc.sku || "Unknown"}`];
  if (doc.sku) parts.push(`SKU: ${doc.sku}`);
  if (doc.type) parts.push(`Type: ${doc.type}`);
  if (doc.brand && doc.brand !== "-") parts.push(`Brand: ${doc.brand}`);
  if (doc.series && doc.series !== "-") parts.push(`Series: ${doc.series}`);
  if (doc.state) parts.push(`Status: ${doc.state}`);
  if (doc.list?.amount) parts.push(`Price: ${fmtMoney(doc.list.amount)} / ${doc.list.uom}`);
  if (doc.cost?.amount) parts.push(`Cost: ${fmtMoney(doc.cost.amount)} / ${doc.cost.uom}`);
  if (doc.tags?.length) parts.push(`Tags: ${doc.tags.join(", ")}`);
  return parts.join(". ") + ".";
}

function caseText(doc: any): string {
  const parts = [`Case #${doc.number || doc._id}: ${doc.name || ""}`];
  if (doc.type) parts.push(`Type: ${doc.type}`);
  if (doc.state) parts.push(`Status: ${doc.state}`);
  if (doc.priority != null) parts.push(`Priority: ${doc.priority}`);
  if (doc.customer?.name) parts.push(`Customer: ${doc.customer.name}`);
  // References carry denormalized project/job names
  const projRef = doc.references?.find((r: any) => r.type === "project");
  if (projRef?.name) parts.push(`Project: ${projRef.name}`);
  if (doc.description) parts.push(`Description: ${truncate(stripHtml(doc.description), 500)}`);
  if (doc.createdAt) parts.push(`Date: ${fmtDate(doc.createdAt)}`);
  if (doc.resolvedAt) parts.push(`Resolved: ${fmtDate(doc.resolvedAt)}`);
  return parts.join(". ") + ".";
}

// ── Object Config ───────────────────────────────────────────────────────────

interface ObjectConfig {
  collection: string;
  qdrant: string;
  objectType: string;
  textBuilder: (doc: any, projectMap: Map<string, ProjectInfo>) => string;
  payloadBuilder: (doc: any, embeddingText: string, projectMap: Map<string, ProjectInfo>) => Record<string, any>;
  /** Watermark field name — defaults to "lastModifiedAt" */
  watermarkField?: string;
}

// ── Payload Builders ────────────────────────────────────────────────────────

function personPayload(doc: any, embeddingText: string): Record<string, any> {
  return {
    dodiId: String(doc._id),
    objectType: "person",
    embeddingText,
    name: doc.name ?? "",
    email: doc.email ?? "",
    phone: doc.phone?.number ?? "",
    natures: doc.natures ?? [],
    updatedAt: doc.lastModifiedAt ?? doc.createdAt ?? "",
  };
}

function projectPayload(doc: any, embeddingText: string): Record<string, any> {
  const homeowner = doc.persons?.find((p: any) => p.roles?.includes("project.homeowner"));
  return {
    dodiId: String(doc._id),
    objectType: "project",
    embeddingText,
    name: doc.name ?? "",
    status: doc.state ?? "",
    customerName: homeowner?.name ?? "",
    projectType: doc.projectType ?? "",
    address: formatAddress(doc.address),
    createdAt: doc.createdAt ?? "",
    updatedAt: doc.lastModifiedAt ?? "",
  };
}

function designPayload(doc: any, embeddingText: string): Record<string, any> {
  return {
    dodiId: String(doc._id),
    objectType: "design",
    embeddingText,
    name: doc.name ?? "",
    projectId: doc.scope ?? "",
    style: doc.spec?.style ?? "",
    roomShape: doc.spec?.roomShape ?? "",
    dimensions: doc.spec?.dimension
      ? `${doc.spec.dimension.x}" × ${doc.spec.dimension.y}" × ${doc.spec.dimension.z}"`
      : "",
    updatedAt: doc.lastModifiedAt ?? "",
  };
}

function quotePayload(doc: any, embeddingText: string, projectMap: Map<string, ProjectInfo>): Record<string, any> {
  const proj = doc.project ? projectMap.get(doc.project) : undefined;
  return {
    dodiId: String(doc._id),
    objectType: "quote",
    embeddingText,
    projectId: doc.project ?? "",
    projectName: proj?.name ?? "",
    customerName: doc.customer?.name ?? "",
    total: doc.total ?? null,
    status: doc.state ?? "",
    lineItemCount: doc.sections?.reduce((sum: number, s: any) => sum + (s.lines?.length ?? 0), 0) ?? 0,
    updatedAt: doc.lastModifiedAt ?? "",
  };
}

function orderPayload(doc: any, embeddingText: string, projectMap: Map<string, ProjectInfo>): Record<string, any> {
  const projId = doc.scope ?? doc.meta?.project;
  const proj = projId ? projectMap.get(projId) : undefined;
  return {
    dodiId: String(doc._id),
    objectType: "order",
    embeddingText,
    projectId: projId ?? "",
    projectName: proj?.name ?? "",
    customerName: doc.customer?.name ?? "",
    total: doc.total ?? null,
    status: doc.state ?? "",
    orderType: doc.type ?? "",
    updatedAt: doc.lastModifiedAt ?? "",
  };
}

function jobPayload(doc: any, embeddingText: string, projectMap: Map<string, ProjectInfo>): Record<string, any> {
  const proj = doc.project ? projectMap.get(doc.project) : undefined;
  return {
    dodiId: String(doc._id),
    objectType: "job",
    embeddingText,
    projectId: doc.project ?? "",
    projectName: proj?.name ?? "",
    status: doc.state ?? "",
    updatedAt: doc.lastModifiedAt ?? "",
  };
}

function taskPayload(doc: any, embeddingText: string): Record<string, any> {
  const projRef = doc.references?.find((r: any) => r.type === "project");
  return {
    dodiId: String(doc._id),
    objectType: "operational_task",
    embeddingText,
    projectId: projRef?._id ?? "",
    status: doc.state ?? "",
    taskType: doc.type ?? "",
    assignee: doc.completedBy?.displayName ?? doc.createdBy?.displayName ?? "",
    updatedAt: doc.lastModifiedAt ?? "",
  };
}

function partPayload(doc: any, embeddingText: string): Record<string, any> {
  return {
    dodiId: String(doc._id),
    objectType: "part",
    embeddingText,
    name: doc.name ?? "",
    family: doc.type ?? "",
    sku: doc.sku ?? "",
    unit: doc.cost?.uom ?? doc.list?.uom ?? "",
    price: doc.list?.amount ?? null,
    cost: doc.cost?.amount ?? null,
    brand: doc.brand ?? "",
    updatedAt: doc.lastModifiedAt ?? "",
  };
}

function casePayload(doc: any, embeddingText: string): Record<string, any> {
  const projRef = doc.references?.find((r: any) => r.type === "project");
  return {
    dodiId: String(doc._id),
    objectType: "case",
    embeddingText,
    projectId: projRef?._id ?? "",
    caseType: doc.type ?? "",
    status: doc.state ?? "",
    customerName: doc.customer?.name ?? "",
    description: truncate(stripHtml(doc.description), 500),
    updatedAt: doc.lastModifiedAt ?? "",
  };
}

// ── Text Builders (additional) ───────────────────────────────────────────────

function commentText(doc: any): string {
  const contextId = doc.context?.[0] ?? "";
  const parts = [`Comment on ${contextId}`];
  if (doc.userName) parts.push(`By: ${doc.userName}`);
  const body = stripHtml(doc.content);
  if (body) parts.push(truncate(body, 800));
  if (doc.createdAt) parts.push(`Date: ${fmtDate(doc.createdAt)}`);
  return parts.join(". ") + ".";
}

function productFamilyText(doc: any): string {
  const parts = [`Product family: ${doc.name || doc.code || "Unknown"}`];
  if (doc.type) parts.push(`Type: ${doc.type}`);
  if (doc.vendor) parts.push(`Vendor: ${doc.vendor}`);
  if (doc.description) parts.push(`Description: ${truncate(doc.description, 500)}`);
  if (doc.code) parts.push(`Code: ${doc.code}`);
  // Include spec options if available
  if (doc.specSchema?.length) {
    const options = doc.specSchema
      .filter((s: any) => s.options?.length)
      .map((s: any) => `${s.label}: ${s.options.join(", ")}`)
      .join("; ");
    if (options) parts.push(`Options: ${truncate(options, 300)}`);
  }
  return parts.join(". ") + ".";
}

function designIterationText(doc: any): string {
  const designId = doc.designId || doc.deisgnId || "Unknown";
  const parts = [`Design iteration: ${designId} v${doc.version ?? "?"}`];
  if (doc.state) parts.push(`Status: ${doc.state}`);
  const spec = doc.spec;
  if (spec) {
    if (spec.style) parts.push(`Style: ${spec.style}`);
    if (spec.roomShape) parts.push(`Room shape: ${spec.roomShape}`);
    if (spec.dimension) {
      const d = spec.dimension;
      parts.push(`Room dimensions: ${d.x}" × ${d.y}" × ${d.z}"`);
    }
    if (spec.buildSpec) {
      const bs = spec.buildSpec;
      if (bs.boxMaterial) parts.push(`Box material: ${bs.boxMaterial}`);
      if (bs.drawerBox) parts.push(`Drawer box: ${bs.drawerBox}`);
      if (bs.hardwareBrand) parts.push(`Hardware: ${bs.hardwareBrand}`);
    }
    // Extract unique materials and cabinet models (skip heavy geometry)
    const materials = new Set<string>();
    const cabinetModels = new Set<string>();
    for (const run of spec.runs ?? []) {
      for (const el of run.elements ?? []) {
        if (el.material?.name) materials.add(el.material.name);
        if (el.model) cabinetModels.add(el.model);
      }
    }
    if (materials.size > 0) parts.push(`Materials: ${[...materials].join(", ")}`);
    if (cabinetModels.size > 0) parts.push(`Cabinets: ${[...cabinetModels].join(", ")}`);
  }
  if (doc.savedAt) parts.push(`Saved: ${fmtDate(doc.savedAt)}`);
  return parts.join(". ") + ".";
}

// ── Payload Builders (additional) ────────────────────────────────────────────

function commentPayload(doc: any, embeddingText: string): Record<string, any> {
  const contextId = doc.context?.[0] ?? "";
  // Determine comment target type from context ID prefix
  let targetType = "unknown";
  if (contextId.startsWith("PROJECT-")) targetType = "project";
  else if (contextId.startsWith("PLAN-")) targetType = "design";
  else if (contextId.startsWith("JOB-")) targetType = "job";
  else if (contextId.startsWith("TASK-")) targetType = "task";
  else if (contextId.startsWith("CASE-")) targetType = "case";

  return {
    dodiId: String(doc._id),
    objectType: "comment",
    embeddingText,
    targetId: contextId,
    targetType,
    projectId: doc.projectId ?? "",
    author: doc.userName ?? "",
    updatedAt: doc.createdAt ?? "",
  };
}

function productFamilyPayload(doc: any, embeddingText: string): Record<string, any> {
  return {
    dodiId: String(doc._id),
    objectType: "product_family",
    embeddingText,
    name: doc.name ?? "",
    code: doc.code ?? "",
    familyType: doc.type ?? "",
    vendor: doc.vendor ?? "",
    updatedAt: doc.lastModifiedAt ?? "",
  };
}

function designIterationPayload(doc: any, embeddingText: string): Record<string, any> {
  const designId = doc.designId || doc.deisgnId || "";
  return {
    dodiId: String(doc._id),
    objectType: "design_iteration",
    embeddingText,
    designId,
    version: doc.version ?? 0,
    style: doc.spec?.style ?? "",
    roomShape: doc.spec?.roomShape ?? "",
    dimensions: doc.spec?.dimension
      ? `${doc.spec.dimension.x}" × ${doc.spec.dimension.y}" × ${doc.spec.dimension.z}"`
      : "",
    updatedAt: doc.savedAt ?? "",
  };
}

// ── Object Configs ──────────────────────────────────────────────────────────

const OBJECT_CONFIGS: ObjectConfig[] = [
  {
    collection: "persons",
    qdrant: "persons",
    objectType: "person",
    textBuilder: (doc) => personText(doc),
    payloadBuilder: (doc, text) => personPayload(doc, text),
  },
  {
    collection: "projects",
    qdrant: "projects",
    objectType: "project",
    textBuilder: (doc) => projectText(doc),
    payloadBuilder: (doc, text) => projectPayload(doc, text),
  },
  {
    collection: "designs",
    qdrant: "designs",
    objectType: "design",
    textBuilder: (doc) => designText(doc),
    payloadBuilder: (doc, text) => designPayload(doc, text),
  },
  {
    collection: "quotes",
    qdrant: "quotes",
    objectType: "quote",
    textBuilder: (doc, pm) => quoteText(doc, pm),
    payloadBuilder: (doc, text, pm) => quotePayload(doc, text, pm),
  },
  {
    collection: "orders",
    qdrant: "orders",
    objectType: "order",
    textBuilder: (doc, pm) => orderText(doc, pm),
    payloadBuilder: (doc, text, pm) => orderPayload(doc, text, pm),
  },
  {
    collection: "jobs",
    qdrant: "jobs",
    objectType: "job",
    textBuilder: (doc, pm) => jobText(doc, pm),
    payloadBuilder: (doc, text, pm) => jobPayload(doc, text, pm),
  },
  {
    collection: "tasks",
    qdrant: "operational_tasks",
    objectType: "operational_task",
    textBuilder: (doc) => operationalTaskText(doc),
    payloadBuilder: (doc, text) => taskPayload(doc, text),
  },
  {
    collection: "parts",
    qdrant: "parts",
    objectType: "part",
    textBuilder: (doc) => partText(doc),
    payloadBuilder: (doc, text) => partPayload(doc, text),
  },
  {
    collection: "cases",
    qdrant: "cases",
    objectType: "case",
    textBuilder: (doc) => caseText(doc),
    payloadBuilder: (doc, text) => casePayload(doc, text),
  },
  {
    collection: "project_comments",
    qdrant: "comments",
    objectType: "comment",
    textBuilder: (doc) => commentText(doc),
    payloadBuilder: (doc, text) => commentPayload(doc, text),
    watermarkField: "createdAt",
  },
  {
    collection: "product_families",
    qdrant: "product_families",
    objectType: "product_family",
    textBuilder: (doc) => productFamilyText(doc),
    payloadBuilder: (doc, text) => productFamilyPayload(doc, text),
  },
];

// ── Qdrant Collection Ensurer ───────────────────────────────────────────────

async function ensureCollection(qdrant: QdrantClient, name: string): Promise<void> {
  let needsCreate = false;
  try {
    const info = await qdrant.getCollection(name);
    // Check vector dimensions match — recreate if mismatched (e.g. 768 → 1024 migration)
    const vCfg = info.config?.params?.vectors as any;
    const existingSize = vCfg?.size ?? null;
    if (existingSize && existingSize !== EMBED_DIMS) {
      console.log(`  Recreating Qdrant collection ${name}: dimension ${existingSize} → ${EMBED_DIMS}`);
      await qdrant.deleteCollection(name);
      needsCreate = true;
    }
  } catch {
    needsCreate = true;
  }

  if (!needsCreate) return;

  console.log(`  Creating Qdrant collection: ${name}`);
  await qdrant.createCollection(name, {
    vectors: { size: EMBED_DIMS, distance: "Cosine" },
  });
  await qdrant.createPayloadIndex(name, { field_name: "dodiId", field_schema: "keyword" });
  await qdrant.createPayloadIndex(name, { field_name: "objectType", field_schema: "keyword" });
  if (["projects", "designs", "quotes", "orders", "jobs", "operational_tasks", "cases"].includes(name)) {
    await qdrant.createPayloadIndex(name, { field_name: "status", field_schema: "keyword" });
  }
  if (["designs", "quotes", "orders", "jobs", "operational_tasks", "cases", "comments"].includes(name)) {
    await qdrant.createPayloadIndex(name, { field_name: "projectId", field_schema: "keyword" });
  }
  if (name === "parts") {
    await qdrant.createPayloadIndex(name, { field_name: "family", field_schema: "keyword" });
  }
  if (name === "comments") {
    await qdrant.createPayloadIndex(name, { field_name: "targetType", field_schema: "keyword" });
    await qdrant.createPayloadIndex(name, { field_name: "targetId", field_schema: "keyword" });
  }
  if (name === "product_families") {
    await qdrant.createPayloadIndex(name, { field_name: "familyType", field_schema: "keyword" });
    await qdrant.createPayloadIndex(name, { field_name: "vendor", field_schema: "keyword" });
  }
}

// ── Qdrant Upsert ───────────────────────────────────────────────────────────

async function upsertPoints(
  qdrant: QdrantClient,
  collection: string,
  points: { id: string; vector: number[]; payload: Record<string, any> }[],
): Promise<void> {
  for (let i = 0; i < points.length; i += QDRANT_UPSERT_BATCH) {
    const slice = points.slice(i, i + QDRANT_UPSERT_BATCH);
    await qdrant.upsert(collection, {
      wait: true,
      points: slice.map((p) => ({
        id: p.id,
        vector: p.vector,
        payload: p.payload,
      })),
    });
  }
}

// ── Main Processing ─────────────────────────────────────────────────────────

async function processObjectType(
  db: Db,
  qdrant: QdrantClient,
  config: ObjectConfig,
  projectMap: Map<string, ProjectInfo>,
): Promise<{ total: number; embedded: number; skipped: number }> {
  const { collection, qdrant: qdrantCol, objectType, textBuilder, payloadBuilder } = config;
  const watermarkField = config.watermarkField ?? "lastModifiedAt";
  const metaCol = db.collection("embed_meta");
  const sourceCol = db.collection(collection);

  // Read watermark
  let query: Record<string, any> = {};
  if (!reembed) {
    const meta = await metaCol.findOne({ objectType });
    const lastEmbedAt = meta?.lastEmbedAt ?? null;
    if (lastEmbedAt) {
      query = { [watermarkField]: { $gt: lastEmbedAt } };
    }
  }

  const total = await sourceCol.countDocuments(query);
  console.log(`  ${objectType}: ${total} records to process`);

  if (total === 0) {
    return { total: 0, embedded: 0, skipped: 0 };
  }

  if (dryRun) {
    return { total, embedded: 0, skipped: 0 };
  }

  // Ensure Qdrant collection exists
  await ensureCollection(qdrant, qdrantCol);

  // For designs, use lightweight projection to skip heavy fields
  const projection = collection === "designs"
    ? { thumbnail: 0, "proposals.runs.elements": 0, "spec.measures": 0 }
    : {};

  const cursor = sourceCol.find(query, { projection }).sort({ [watermarkField]: 1 });
  let embedded = 0;
  let skipped = 0;
  let batch: { doc: any; text: string }[] = [];
  let maxWatermark: Date | null = null;
  const startMs = Date.now();

  const flushBatch = async () => {
    if (batch.length === 0) return;

    const texts = batch.map((b) => b.text);

    let embeddings: number[][];
    try {
      embeddings = await embedBatch(texts);
    } catch (err: any) {
      if (err.message?.includes("context length")) {
        console.warn(`  Batch too long, falling back to individual embeds (${texts.length} docs)`);
        embeddings = [];
        for (const t of texts) {
          const short = t.length > 500 ? t.slice(0, 500) : t;
          const [vec] = await embedBatch([short]);
          embeddings.push(vec!);
        }
      } else {
        throw err;
      }
    }

    const points = batch.map((item, i) => {
      const payload = payloadBuilder(item.doc, item.text, projectMap);
      const id = pointId(objectType, String(item.doc._id));
      return { id, vector: embeddings[i]!, payload };
    });

    await upsertPoints(qdrant, qdrantCol, points);
    embedded += batch.length;
    batch = [];
  };

  for await (const doc of cursor) {
    // Track max watermark
    const wm = doc[watermarkField];
    if (wm) {
      const wmDate = new Date(wm);
      if (!maxWatermark || wmDate > maxWatermark) {
        maxWatermark = wmDate;
      }
    }

    const text = truncate(textBuilder(doc, projectMap));
    if (!text || text.length < 5) {
      skipped++;
      continue;
    }

    batch.push({ doc, text });

    if (batch.length >= EMBED_BATCH_SIZE) {
      await flushBatch();
      if ((embedded + skipped) % 1000 === 0) {
        console.log(`    ${objectType}: ${embedded} embedded, ${skipped} skipped (${elapsed(startMs)})`);
      }
    }
  }

  // Flush remaining
  await flushBatch();

  // Update watermark
  if (maxWatermark) {
    await metaCol.updateOne(
      { objectType },
      {
        $set: {
          lastEmbedAt: maxWatermark,
          recordCount: embedded,
          updatedAt: new Date(),
        },
      },
      { upsert: true },
    );
  }

  console.log(`  ${objectType}: done — ${embedded} embedded, ${skipped} skipped (${elapsed(startMs)})`);
  return { total, embedded, skipped };
}

// ── Design Iterations (latest version per design) ───────────────────────────

async function processDesignIterations(
  db: Db,
  qdrant: QdrantClient,
): Promise<{ total: number; embedded: number; skipped: number }> {
  const objectType = "design_iteration";
  const metaCol = db.collection("embed_meta");
  const sourceCol = db.collection("design_iterations");
  const qdrantCol = "designs"; // upsert alongside designs

  // Use aggregation to get latest version per designId
  // Handle both "designId" and "deisgnId" (typo) fields
  const pipeline: any[] = [
    {
      $addFields: {
        _designId: { $ifNull: ["$designId", "$deisgnId"] },
      },
    },
    { $sort: { version: -1 as const } },
    {
      $group: {
        _id: "$_designId",
        doc: { $first: "$$ROOT" },
      },
    },
    { $replaceRoot: { newRoot: "$doc" } },
  ];

  // Add watermark filter if incremental
  if (!reembed) {
    const meta = await metaCol.findOne({ objectType });
    const lastEmbedAt = meta?.lastEmbedAt ?? null;
    if (lastEmbedAt) {
      pipeline.unshift({ $match: { savedAt: { $gt: lastEmbedAt } } });
    }
  }

  // Strip heavy fields
  pipeline.push({
    $project: {
      thumbnail: 0,
      "proposals.runs.elements.bom": 0,
      "proposals.runs.elements.bomLines": 0,
      "spec.runs.elements.bom": 0,
      "spec.runs.elements.bomLines": 0,
      "spec.measures": 0,
    },
  });

  const docs = await sourceCol.aggregate(pipeline).toArray();
  const total = docs.length;
  console.log(`  ${objectType}: ${total} latest iterations to process`);

  if (total === 0) return { total: 0, embedded: 0, skipped: 0 };
  if (dryRun) return { total, embedded: 0, skipped: 0 };

  await ensureCollection(qdrant, qdrantCol);

  let embedded = 0;
  let skipped = 0;
  let maxSavedAt: Date | null = null;
  let batch: { doc: any; text: string }[] = [];
  const startMs = Date.now();

  const flushBatch = async () => {
    if (batch.length === 0) return;
    const texts = batch.map((b) => b.text);
    let embeddings: number[][];
    try {
      embeddings = await embedBatch(texts);
    } catch (err: any) {
      if (err.message?.includes("context length")) {
        console.warn(`  Batch too long, falling back to individual embeds`);
        embeddings = [];
        for (const t of texts) {
          const [vec] = await embedBatch([t.length > 500 ? t.slice(0, 500) : t]);
          embeddings.push(vec!);
        }
      } else {
        throw err;
      }
    }

    const points = batch.map((item, i) => {
      const payload = designIterationPayload(item.doc, item.text);
      // Use designId for point ID so it upserts over stale versions
      const designId = item.doc.designId || item.doc.deisgnId || item.doc._id;
      const id = pointId(objectType, String(designId));
      return { id, vector: embeddings[i]!, payload };
    });

    await upsertPoints(qdrant, qdrantCol, points);
    embedded += batch.length;
    batch = [];
  };

  for (const doc of docs) {
    if (doc.savedAt) {
      const d = new Date(doc.savedAt);
      if (!maxSavedAt || d > maxSavedAt) maxSavedAt = d;
    }

    const text = truncate(designIterationText(doc));
    if (!text || text.length < 5) {
      skipped++;
      continue;
    }

    batch.push({ doc, text });
    if (batch.length >= EMBED_BATCH_SIZE) {
      await flushBatch();
      if ((embedded + skipped) % 500 === 0) {
        console.log(`    ${objectType}: ${embedded} embedded, ${skipped} skipped (${elapsed(startMs)})`);
      }
    }
  }

  await flushBatch();

  if (maxSavedAt) {
    await metaCol.updateOne(
      { objectType },
      { $set: { lastEmbedAt: maxSavedAt, recordCount: embedded, updatedAt: new Date() } },
      { upsert: true },
    );
  }

  console.log(`  ${objectType}: done — ${embedded} embedded, ${skipped} skipped (${elapsed(startMs)})`);
  return { total, embedded, skipped };
}

// ── Main ────────────────────────────────────────────────────────────────────

async function main(): Promise<void> {
  const startTime = Date.now();

  console.log(`dodi Embed: master → Ollama (${EMBED_MODEL}, ${EMBED_DIMS}d) → Qdrant`);
  console.log(`  MongoDB:   ${MONGODB_DODI_URI}`);
  console.log(`  Ollama:    ${OLLAMA_URL}`);
  console.log(`  Qdrant:    ${QDRANT_URL}`);
  console.log(`  Batch:     ${EMBED_BATCH_SIZE}`);
  console.log(`  Mode:      ${dryRun ? "DRY RUN" : reembed ? "REEMBED ALL" : "INCREMENTAL"}`);
  if (objectsFilter) console.log(`  Filter:    --objects ${objectsFilter}`);

  // Verify Ollama is running
  if (!dryRun) {
    try {
      const res = await fetch(`${OLLAMA_URL}/api/tags`);
      if (!res.ok) throw new Error(`status ${res.status}`);
      console.log("  Ollama:    connected");
    } catch (err: any) {
      console.error(`Error: Cannot connect to Ollama at ${OLLAMA_URL}: ${err.message}`);
      process.exit(1);
    }
  }

  // Connect to Qdrant
  const qdrant = new QdrantClient({ url: QDRANT_URL });
  if (!dryRun) {
    try {
      await qdrant.getCollections();
      console.log("  Qdrant:    connected");
    } catch (err: any) {
      console.error(`Error: Cannot connect to Qdrant at ${QDRANT_URL}: ${err.message}`);
      process.exit(1);
    }
  }

  // Connect to MongoDB
  const mongo = new MongoClient(MONGODB_DODI_URI);
  await mongo.connect();
  const db = mongo.db();
  console.log("  MongoDB:   connected");

  // Load enrichment data
  console.log("\nLoading enrichment data...");
  const projectMap = await loadProjectMap(db);

  // Filter configs if --objects specified
  const configs = objectsFilter
    ? OBJECT_CONFIGS.filter((c) => c.objectType === objectsFilter)
    : OBJECT_CONFIGS;

  if (configs.length === 0 && objectsFilter !== "design_iteration") {
    console.error(`Error: Unknown object type "${objectsFilter}"`);
    console.error(`Valid types: ${OBJECT_CONFIGS.map((c) => c.objectType).join(", ")}, design_iteration`);
    await mongo.close();
    process.exit(1);
  }

  // Process each object type
  console.log("\nProcessing...");
  const results: Record<string, { total: number; embedded: number; skipped: number }> = {};

  for (const config of configs) {
    results[config.objectType] = await processObjectType(db, qdrant, config, projectMap);
  }

  // Design iterations — latest version per design (separate processing)
  if (!objectsFilter || objectsFilter === "design_iteration") {
    results["design_iteration"] = await processDesignIterations(db, qdrant);
  }

  await mongo.close();

  // Summary
  console.log("\n=== Summary ===");
  console.log(`Duration: ${elapsed(startTime)}${dryRun ? " (DRY RUN)" : ""}`);
  console.log(`Model: ${EMBED_MODEL} (${EMBED_DIMS} dims)`);
  let totalEmbedded = 0;
  let totalSkipped = 0;
  for (const [type, result] of Object.entries(results)) {
    console.log(`  ${type}: ${result.embedded} embedded, ${result.skipped} skipped (of ${result.total})`);
    totalEmbedded += result.embedded;
    totalSkipped += result.skipped;
  }
  console.log(`Total: ${totalEmbedded} embedded, ${totalSkipped} skipped`);
  console.log("Done.");
}

main().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
