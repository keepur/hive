/**
 * Kernel sandbox-denial collector shared by T2 and T10.
 * Unavailable denial evidence fails closed.
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** Daemons that log sandbox denials against the job tree without being job descendants. */
export const NON_JOB_SANDBOX_SUBJECTS = new Set(["logd_helper", "logd", "contactsd", "syslogd", "UserEventAgent"]);

export function startDenialCollector() {
  const startedAt = new Date();
  const child = spawn(
    "/usr/bin/log",
    ["stream", "--style", "compact", "--predicate", 'eventMessage CONTAINS "Sandbox:" AND eventMessage CONTAINS "deny"'],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  const chunks = [];
  child.stdout?.on("data", (chunk) => chunks.push(chunk));
  child.stderr?.on("data", (chunk) => chunks.push(chunk));
  let exitCode = null;
  child.on("exit", (code) => {
    exitCode = code;
  });
  return {
    startedAt,
    pids: new Set(),
    async stop() {
      await new Promise((resolvePromise) => setTimeout(resolvePromise, 2_000));
      if (exitCode === null) child.kill("SIGTERM");
      const streamed = Buffer.concat(chunks).toString("utf8");
      const start = startedAt.toISOString().replace("T", " ").replace("Z", "");
      const shown = spawnSync(
        "/usr/bin/log",
        [
          "show",
          "--style",
          "compact",
          "--predicate",
          'eventMessage CONTAINS "Sandbox:" AND eventMessage CONTAINS "deny"',
          "--start",
          start,
        ],
        { encoding: "utf8", timeout: 30_000 },
      );
      const evidence = `${streamed}\n${shown.stdout ?? ""}\n${shown.stderr ?? ""}`;
      if (exitCode && exitCode !== 0 && shown.status !== 0 && evidence.trim().length === 0) {
        throw new Error("sandbox denial evidence unavailable");
      }
      return evidence;
    },
  };
}

export function sandboxSubject(line) {
  const match = line.match(/Sandbox:\s+(\S+?)\((\d+)\)/);
  return match ? { name: match[1], pid: Number(match[2]) } : null;
}

export function isJobDenial(line, pids, token) {
  if (!line.includes("Sandbox:") || !/\bdeny\b/i.test(line)) return false;
  // Production self-test must deny this sibling write; it is not an install leak.
  if (line.includes(".outside")) return false;
  const subject = sandboxSubject(line);
  if (subject && NON_JOB_SANDBOX_SUBJECTS.has(subject.name)) return false;
  if (subject && pids.has(subject.pid)) return true;
  // Short-lived descendants (make, node-gyp) may exit before PID sampling; count
  // them only when the kernel record names this scratch tree.
  return Boolean(subject && line.includes(token));
}

export function jobDenialLines(evidence, pids, token) {
  return evidence.split("\n").filter((line) => isJobDenial(line, pids, token));
}

/** True only when npm wrote a debug/log *file* under the job's npm-logs directory. */
export function npmDebugLogPresent(jobPath, logsDirName = "npm-logs") {
  const directory = join(jobPath, logsDirName);
  if (!existsSync(directory)) return false;
  const files = [];
  const visit = (current) => {
    for (const entry of readdirSync(current, { withFileTypes: true })) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) visit(path);
      else files.push(path);
    }
  };
  visit(directory);
  return files.some((file) => /debug/i.test(file) || file.endsWith(".log"));
}

export function trackJobSpawns(io, collectorOrGet) {
  const current = () => (typeof collectorOrGet === "function" ? collectorOrGet() : collectorOrGet);
  return {
    ...io,
    spawn(command, args, options) {
      return io.spawn(command, args, {
        ...options,
        onSpawn(pid) {
          current()?.pids.add(pid);
          options.onSpawn?.(pid);
        },
      });
    },
  };
}
