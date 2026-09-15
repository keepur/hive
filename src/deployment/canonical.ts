/**
 * Canonical JSON encoding shared by deployment evidence records (KPR-463 plan
 * chunk 4 Task 9 Step 4a.1). Builtin-only. Only null, booleans, strings, safe
 * integers, arrays and plain objects are representable; object keys are
 * sorted so equal values have equal bytes.
 */
export function canonical(value: unknown): string {
  if (value === null || typeof value === "boolean" || typeof value === "string") return JSON.stringify(value);
  if (typeof value === "number" && Number.isSafeInteger(value)) return String(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const row = value as Record<string, unknown>;
    return `{${Object.keys(row)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonical(row[key])}`)
      .join(",")}}`;
  }
  throw new Error("record contains non-JSON value");
}

/** Accept only bytes equal to the canonical encoding plus one newline. */
export function parseCanonical(bytes: Buffer): unknown {
  if (bytes.length > 1024 * 1024) throw new Error("record too large");
  const parsed: unknown = JSON.parse(bytes.toString("utf8"));
  if (!bytes.equals(Buffer.from(`${canonical(parsed)}\n`))) throw new Error("noncanonical record");
  return parsed;
}
