/**
 * Render an error including its `cause` chain. `String(err)` on undici-era
 * fetch failures yields only "TypeError: fetch failed" — the actionable
 * detail (e.g. InvalidArgumentError: invalid onError method,
 * UND_ERR_INVALID_ARG) hides in `err.cause` (KPR-344).
 */
export function describeError(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < 5 && current !== undefined && current !== null; depth++) {
    if (current instanceof Error) {
      const code = (current as NodeJS.ErrnoException).code;
      parts.push(`${current.name}: ${current.message}${code ? ` (${code})` : ""}`);
      current = current.cause;
    } else {
      // Unconditionally throw-safe: this helper runs inside catch handlers.
      try {
        parts.push(String(current));
      } catch {
        parts.push("<unrenderable>");
      }
      break;
    }
  }
  return parts.join(" ← ");
}
