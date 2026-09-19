import { describe, it, expect } from "vitest";
import { buildRotateLogsPlist, parseRotateWeekday } from "./rotate-logs-plist.ts";

const opts = {
  label: "com.hive.acme.rotate-logs",
  deployDir: "/Users/op/services/hive/acme",
  logsDir: "/Users/op/services/hive/acme/logs",
  home: "/Users/op",
  pathEnv: "/opt/homebrew/bin:/usr/bin:/bin",
};

/** The <dict> body that follows StartCalendarInterval. */
function calendarInterval(plist: string): string {
  const match = /<key>StartCalendarInterval<\/key>\s*<dict>([\s\S]*?)<\/dict>/.exec(plist);
  if (!match) throw new Error("plist has no StartCalendarInterval dict");
  return match[1];
}

describe("parseRotateWeekday", () => {
  it("treats unset and blank as daily", () => {
    expect(parseRotateWeekday(undefined)).toBeUndefined();
    expect(parseRotateWeekday("")).toBeUndefined();
    expect(parseRotateWeekday("  ")).toBeUndefined();
  });

  it("accepts every launchd weekday, including both Sundays", () => {
    expect(parseRotateWeekday("0")).toBe(0);
    expect(parseRotateWeekday(" 3 ")).toBe(3);
    expect(parseRotateWeekday("7")).toBe(7);
  });

  it("rejects anything that is not a launchd weekday", () => {
    for (const bad of ["8", "-1", "1.5", "sunday", "07", "1 2"]) {
      expect(() => parseRotateWeekday(bad), bad).toThrow(/HIVE_ROTATE_LOGS_WEEKDAY/);
    }
  });
});

describe("buildRotateLogsPlist", () => {
  it("runs the engine-bundle script daily at 04:00 by default", () => {
    const plist = buildRotateLogsPlist(opts);
    expect(plist).toContain("<string>/Users/op/services/hive/acme/.hive/service/rotate-logs.sh</string>");
    expect(calendarInterval(plist)).not.toContain("Weekday");
    expect(calendarInterval(plist)).toMatch(/<key>Hour<\/key>\s*<integer>4<\/integer>/);
    expect(calendarInterval(plist)).toMatch(/<key>Minute<\/key>\s*<integer>0<\/integer>/);
  });

  it("passes HIVE_HOME so rotate-logs.sh runs in single-instance mode", () => {
    const plist = buildRotateLogsPlist(opts);
    expect(plist).toMatch(/<key>HIVE_HOME<\/key>\s*<string>\/Users\/op\/services\/hive\/acme<\/string>/);
  });

  it("adds a Weekday key for a weekly schedule — Sunday (0) included", () => {
    expect(calendarInterval(buildRotateLogsPlist({ ...opts, weekday: 0 }))).toMatch(
      /<key>Weekday<\/key>\s*<integer>0<\/integer>/,
    );
    expect(calendarInterval(buildRotateLogsPlist({ ...opts, weekday: 3 }))).toMatch(
      /<key>Weekday<\/key>\s*<integer>3<\/integer>/,
    );
  });

  it("logs the job's own output under the instance logs dir", () => {
    const plist = buildRotateLogsPlist(opts);
    expect(plist.match(/<string>\/Users\/op\/services\/hive\/acme\/logs\/rotate-logs\.log<\/string>/g)).toHaveLength(2);
  });
});
