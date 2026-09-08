import type { Deadline, Obligation } from "./types.js";
import { fail } from "./types.js";

const MINUTE = 60_000;
const SEARCH_MINUTES = 16 * 24 * 60;
const formatters = new Map<string, Intl.DateTimeFormat>();
const week = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function formatter(zone: string): Intl.DateTimeFormat {
  let f = formatters.get(zone);
  if (!f) {
    f = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      weekday: "short",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
    // Bounded cache; registration itself has no artificial count limit.
    if (formatters.size >= 100) formatters.delete(formatters.keys().next().value!);
    formatters.set(zone, f);
  }
  return f;
}
export function matches(rule: Deadline, date: Date): boolean {
  if (!Number.isFinite(date.getTime()) || date.getTime() % MINUTE !== 0) return false;
  const p = Object.fromEntries(
    formatter(rule.timezone)
      .formatToParts(date)
      .map((v) => [v.type, v.value]),
  );
  return p.hour + ":" + p.minute === rule.localTime && rule.weekdays.includes(week.indexOf(p.weekday!));
}
export function adjacent(rule: Deadline, instant: Date, direction: 1 | -1): Date {
  let ms =
    direction === 1
      ? Math.floor(instant.getTime() / MINUTE) * MINUTE + MINUTE
      : Math.ceil(instant.getTime() / MINUTE) * MINUTE - MINUTE;
  for (let i = 0; i < SEARCH_MINUTES; i++, ms += direction * MINUTE) {
    const d = new Date(ms);
    if (matches(rule, d)) return d;
  }
  return fail("deadline_search_exhausted");
}
/** At most budget UTC minutes; through moves only across examined instants. */
export function scan(
  rule: Deadline,
  from: Date,
  to: Date,
  budget = 1440,
): {
  due: Date[];
  through: Date;
} {
  if (!Number.isInteger(budget) || budget < 1) return fail("invalid_scan_budget");
  if (to <= from) return { due: [], through: from };
  const due: Date[] = [];
  let ms = Math.floor(from.getTime() / MINUTE) * MINUTE + MINUTE;
  let examined = 0;
  let through = from;
  while (ms <= to.getTime() && examined < budget) {
    const date = new Date(ms);
    if (matches(rule, date)) due.push(date);
    through = date;
    examined++;
    ms += MINUTE;
  }
  if (ms > to.getTime()) through = to;
  return { due, through };
}
export function windowStart(o: Obligation, dueAt: Date): Date {
  if (dueAt <= o.activeFrom || !matches(o.deadline, dueAt)) return fail("invalid_occurrence");
  return new Date(Math.max(adjacent(o.deadline, dueAt, -1).getTime(), o.activeFrom.getTime()));
}
export function currentDue(o: Obligation, now: Date): Date | null {
  // The lower bound is exclusive. Exactly at a deadline, that occurrence
  // remains current; one millisecond later the next window is open.
  if (now <= o.activeFrom) return null;
  const due = matches(o.deadline, now) ? now : adjacent(o.deadline, now, 1);
  return o.deactivatedAt && due > o.deactivatedAt ? null : due;
}
export function localDeadline(o: Pick<Obligation, "deadline">, date: Date): string {
  return (
    new Intl.DateTimeFormat("en-GB", {
      timeZone: o.deadline.timezone,
      dateStyle: "medium",
      timeStyle: "long",
    }).format(date) +
    " [" +
    o.deadline.timezone +
    "]"
  );
}
