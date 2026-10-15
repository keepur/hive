import type { HealthReporter } from "./health-reporter.js";
import type { WorkItem } from "../types/work-item.js";

/**
 * NOTE: this module currently has no importers. The live interception path is
 * Dispatcher (src/channels/dispatcher.ts), whose exported STATUS_PATTERNS is the
 * single source of truth and is covered by dispatcher.test.ts.
 *
 * This copy is kept in sync deliberately. It was left behind as bare /^status$/
 * and /^health$/ when the fleet report moved behind a "hive" prefix — a bare
 * "status" must reach the agent it was asked of rather than being answered by
 * the fleet health report. If this module were ever wired up, the stale copy
 * would silently reintroduce that bug, so it is corrected here rather than left
 * as a landmine.
 *
 * This duplication should be collapsed or this file deleted — flagged for a
 * follow-up decision, not done here to keep the change scoped.
 */
const STATUS_PATTERNS = [
  /^hive\s+status\??$/i,
  /^hive\s+health\??$/i,
  /how.*(everyone|agents?|doing|running)/i,
  /system status/i,
];

export function isStatusQuery(item: WorkItem): boolean {
  return STATUS_PATTERNS.some((p) => p.test(item.text.trim()));
}

export function handleStatusQuery(reporter: HealthReporter): string {
  return reporter.formatForSlack();
}
