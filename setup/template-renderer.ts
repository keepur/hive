/**
 * Shared template renderer for Hive agent generation and setup wizard.
 *
 * Supports:
 *   {{key.sub-key}}                  – dot-path variable substitution (hyphens OK)
 *   {{#path.to.key}}...{{/path.to.key}} – conditional blocks (truthy = render, falsy = remove)
 *   {{#sms_section}}...{{/sms_section}} – special SMS block (kept in generate-agents)
 */

import { createHash } from "node:crypto";

/**
 * Resolve a dot-separated path (supporting hyphens) against a nested object.
 * Returns `undefined` when any segment is missing.
 */
function resolvePath(ctx: Record<string, any>, path: string): any {
  const parts = path.split(".");
  let val: any = ctx;
  for (const p of parts) {
    val = val?.[p];
    if (val === undefined) return undefined;
  }
  return val;
}

/**
 * Render a template string by replacing variables and evaluating conditional blocks.
 *
 * Processing order:
 *   1. {{#sms_section}}...{{/sms_section}}  – handled by caller (SMS-specific logic)
 *   2. {{#path.to.key}}...{{/path.to.key}}  – generic conditional blocks
 *   3. {{path.to.key}}                      – variable substitution
 */
export function render(template: string, ctx: Record<string, any>): string {
  // ---- 1. Generic conditional blocks ----------------------------------------
  // Match {{#some.path-key}}...{{/some.path-key}} but NOT {{#sms_section}}
  // which is handled separately by generate-agents before calling render.
  template = template.replace(
    /\{\{#([\w][\w-]*(?:\.[\w][\w-]*)*)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
    (full, path, block) => {
      // Skip sms_section — it's handled by the caller with special logic
      if (path === "sms_section") return full;

      const val = resolvePath(ctx, path);
      // Truthy: non-null, non-undefined, non-empty-string
      if (val !== null && val !== undefined && val !== "") {
        return block;
      }
      return "";
    },
  );

  // ---- 2. Variable substitution ---------------------------------------------
  // Matches {{key}}, {{key.sub}}, {{key.sub-key}}, {{a.b-c.d}} etc.
  template = template.replace(
    /\{\{([\w][\w-]*(?:\.[\w][\w-]*)*)\}\}/g,
    (match, path) => {
      const val = resolvePath(ctx, path);
      if (val === undefined) return match; // leave unreplaced if not found
      return String(val);
    },
  );

  return template;
}

/**
 * Return a short SHA-256 hex hash of `content` (16 hex chars).
 * Used to detect whether a generated file has been modified by the user.
 */
export function fileHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
