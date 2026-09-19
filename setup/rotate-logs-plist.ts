/**
 * Log-rotation LaunchAgent plist. Lives apart from generate-plist.ts (which
 * writes files on import) so the schedule logic can be unit-tested.
 */

export type RotateLogsPlistOptions = {
  label: string;
  /** Instance home — holds .hive/, logs/ and hive.yaml. */
  deployDir: string;
  logsDir: string;
  home: string;
  pathEnv: string;
  /** launchd Weekday (0-7; 0 and 7 are Sunday). Omit to rotate daily. */
  weekday?: number;
};

/**
 * Parse HIVE_ROTATE_LOGS_WEEKDAY. Unset/empty means "daily"; anything that
 * isn't a launchd weekday throws, so a typo can't silently install the wrong
 * schedule.
 */
export function parseRotateWeekday(raw: string | undefined): number | undefined {
  const value = raw?.trim();
  if (!value) return undefined;
  if (!/^[0-7]$/.test(value)) {
    throw new Error(`HIVE_ROTATE_LOGS_WEEKDAY must be an integer 0-7 (0 and 7 = Sunday), got "${raw}"`);
  }
  return Number(value);
}

export function buildRotateLogsPlist(opts: RotateLogsPlistOptions): string {
  const { label, deployDir, logsDir, home, pathEnv, weekday } = opts;
  const weekdayEntry =
    weekday === undefined
      ? ""
      : `    <key>Weekday</key>
    <integer>${weekday}</integer>
`;
  // HIVE_HOME is what puts rotate-logs.sh in single-instance mode — the
  // instances.conf next to it ships empty, so without it nothing is rotated.
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>

  <key>ProgramArguments</key>
  <array>
    <string>${deployDir}/.hive/service/rotate-logs.sh</string>
  </array>

  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>${pathEnv}</string>
    <key>HOME</key>
    <string>${home}</string>
    <key>HIVE_HOME</key>
    <string>${deployDir}</string>
  </dict>

  <key>StartCalendarInterval</key>
  <dict>
${weekdayEntry}    <key>Hour</key>
    <integer>4</integer>
    <key>Minute</key>
    <integer>0</integer>
  </dict>

  <key>StandardOutPath</key>
  <string>${logsDir}/rotate-logs.log</string>
  <key>StandardErrorPath</key>
  <string>${logsDir}/rotate-logs.log</string>
</dict>
</plist>
`;
}
