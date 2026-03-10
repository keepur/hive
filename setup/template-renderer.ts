/**
 * Shared template renderer for Hive agent generation and setup wizard.
 *
 * Supports:
 *   {{key.sub-key}}                    – dot-path variable substitution (hyphens OK)
 *   {{#path.to.key}}...{{/path.to.key}} – conditional blocks (truthy = render, falsy = remove)
 *   {{^path.to.key}}...{{/path.to.key}} – inverted blocks (falsy = render, truthy = remove)
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

function isTruthy(val: any): boolean {
  return val !== null && val !== undefined && val !== "" && val !== false;
}

/**
 * Render a template string by replacing variables and evaluating conditional blocks.
 *
 * Processing order:
 *   1. {{#sms_section}}...{{/sms_section}}  – handled by caller (SMS-specific logic)
 *   2. {{#path}}...{{/path}} and {{^path}}...{{/path}} – conditional/inverted blocks
 *      (multiple passes to handle nesting)
 *   3. {{path.to.key}}                      – variable substitution
 */
export function render(template: string, ctx: Record<string, any>): string {
  // ---- 1. Conditional blocks (multiple passes for nesting) --------------------
  // Process innermost blocks first, repeat until no more matches.
  let changed = true;
  while (changed) {
    changed = false;

    // Truthy blocks: {{#key}}...{{/key}}
    template = template.replace(
      /\{\{#([\w][\w-]*(?:\.[\w][\w-]*)*)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
      (full, path, block) => {
        if (path === "sms_section") return full;
        changed = true;
        return isTruthy(resolvePath(ctx, path)) ? block : "";
      },
    );

    // Inverted blocks: {{^key}}...{{/key}}
    template = template.replace(
      /\{\{\^([\w][\w-]*(?:\.[\w][\w-]*)*)\}\}([\s\S]*?)\{\{\/\1\}\}/g,
      (_full, path, block) => {
        changed = true;
        return !isTruthy(resolvePath(ctx, path)) ? block : "";
      },
    );
  }

  // ---- 2. Variable substitution ---------------------------------------------
  template = template.replace(/\{\{([\w][\w-]*(?:\.[\w][\w-]*)*)\}\}/g, (match, path) => {
    const val = resolvePath(ctx, path);
    if (val === undefined) return match;
    return String(val);
  });

  return template;
}

/**
 * Return a short SHA-256 hex hash of `content` (16 hex chars).
 * Used to detect whether a generated file has been modified by the user.
 */
export function fileHash(content: string): string {
  return createHash("sha256").update(content).digest("hex").slice(0, 16);
}
