import type { HealthReporter } from "./health-reporter.js";
import type { IncomingMessage } from "../types/agent-config.js";

const STATUS_PATTERNS = [
  /^status\??$/i,
  /how.*(everyone|agents?|doing|running)/i,
  /^health\??$/i,
  /system status/i,
];

export function isStatusQuery(msg: IncomingMessage): boolean {
  return STATUS_PATTERNS.some((p) => p.test(msg.text.trim()));
}

export function handleStatusQuery(reporter: HealthReporter): string {
  return reporter.formatForSlack();
}
