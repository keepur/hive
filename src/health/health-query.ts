import type { HealthReporter } from "./health-reporter.js";
import type { WorkItem } from "../types/work-item.js";

const STATUS_PATTERNS = [/^status\??$/i, /how.*(everyone|agents?|doing|running)/i, /^health\??$/i, /system status/i];

export function isStatusQuery(item: WorkItem): boolean {
  return STATUS_PATTERNS.some((p) => p.test(item.text.trim()));
}

export function handleStatusQuery(reporter: HealthReporter): string {
  return reporter.formatForSlack();
}
