import { createHash } from "node:crypto";
import { ObjectId } from "mongodb";

// ── Qdrant collection name ──
export const CODE_INDEX_COLLECTION = "code_index";

// ── MongoDB document ──
export interface CodeIndexRecord {
  _id?: ObjectId;
  repo: string;
  filePath: string;
  gitSha: string;
  summary: string;
  exports: string[];
  dependencies: string[];
  role: string;
  language: string;
  lineCount: number;
  qdrantPointId: string;
  indexedAt: Date;
  indexVersion: number;
}

// ── Qdrant payload (denormalized for filter+display) ──
export interface CodeIndexPayload {
  [key: string]: unknown;
  repo: string;
  filePath: string;
  role: string;
  language: string;
  summary: string;
}

// ── Haiku extraction output per file ──
export interface FileSummary {
  filePath: string;
  summary: string;
  exports: string[];
  dependencies: string[];
  role: string;
}

// ── Search result ──
export interface CodeSearchResult {
  filePath: string;
  repo: string;
  summary: string;
  exports: string[];
  role: string;
  score: number;
}

// ── Deterministic UUIDv5 from repo:filePath ──
// Uses DNS namespace (6ba7b810-9dad-11d1-80b4-00c04fd430c8)
const UUID_NAMESPACE = Buffer.from("6ba7b8109dad11d180b400c04fd430c8", "hex");

export function deterministicUUID(input: string): string {
  const hash = createHash("sha1")
    .update(Buffer.concat([UUID_NAMESPACE, Buffer.from(input)]))
    .digest();
  // Set version 5 (bits 4-7 of byte 6)
  hash[6] = (hash[6] & 0x0f) | 0x50;
  // Set variant (bits 6-7 of byte 8)
  hash[8] = (hash[8] & 0x3f) | 0x80;
  const hex = hash.toString("hex").slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}

export const INDEX_VERSION = 1;

// ── File role classification hint for Haiku prompt ──
export const ROLE_OPTIONS = [
  "entry",
  "config",
  "model",
  "service",
  "handler",
  "util",
  "test",
  "type-defs",
  "component",
  "hook",
  "middleware",
  "migration",
  "script",
  "other",
] as const;
