import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

// KPR-414: index.ts states its own boundary invariant (KPR-394, restated at
// the "Spawn-capable boundary" marker) but nothing enforced it — the
// worker-pool/scribe wiring silently landed ~330 lines below it. This test
// is a text-scan, not an import: index.ts is a side-effecting main() that
// would boot the engine if imported directly.
//
// The named anchor set in (a)/(b) is an ANCHOR SET, not an exhaustive
// inventory of every spawn-capable surface in the file. outageReplayProcessor
// .start() (index.ts:~840) is a real spawn-capable surface deliberately not
// named here — it sits below the wiring already, so naming it adds nothing
// to the ordering bound. Coverage for surfaces NOT named here comes from (c)'s
// superset sweep, which fails on any unallowlisted `.start(`/`.scanOrphans(`
// occurring before the wiring, named or not. The one residual (c) does not
// close: a spawn-capable surface that starts itself through some spelling
// other than `.start(`/`.scanOrphans(` — accepted, not exhaustive.
describe("boot order — spawn-capable boundary (KPR-414)", () => {
  const source = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8");
  // Strip `//` line comments before scanning — the boundary marker comment
  // itself contains the substring "bgTaskManager.start()" in prose, which
  // would otherwise be a false-positive match for both the anchor scan and
  // the superset sweep below.
  const codeOnly = source
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");

  function offsetOf(needle: string): number {
    const i = codeOnly.indexOf(needle);
    expect(
      i,
      `anchor not found: ${JSON.stringify(needle)} — index.ts may have been renamed/refactored; update this test's anchors`,
    ).toBeGreaterThanOrEqual(0);
    return i;
  }

  it("(a) named wiring and surface anchors are all present", () => {
    // Presence-only pass; offsetOf's own expect() does the assertion. Calling
    // each once here documents the full anchor set in one place.
    offsetOf("await agentManager.activateProviderPlugins()");
    offsetOf("agentManager.setWorkerPool(");
    offsetOf("await workerPool.ensureIndexes()");
    offsetOf("dispatcher.setMeetingScribe(");
    offsetOf("dispatcher.setMeetingAckEnabled(");
    // KPR-417: the ARGUMENT, not just the call. The delegated Gate-1
    // assumption is that ackEnabled is independent of `enabled`, and
    // config.test.ts pins that only in the RESOLVER. The realistic nesting
    // site is right here at the consumption end — `enabled && ackEnabled`
    // would keep every resolver test green. That is exactly where
    // scribeEnabled's own nesting lives (meeting-scribe.ts, not config.ts),
    // so this anchor is what closes the gap at the one live feed.
    offsetOf("dispatcher.setMeetingAckEnabled(config.meetingWorkers.ackEnabled)");
    // KPR-452: the audit routing control is a spawn-read fact (the admin
    // audit_channel_get/set tools read the module-global accessor per turn),
    // so its wiring must precede every spawn-capable surface. Note that
    // dispatcher.setAuditChannel(...) deliberately stays BELOW — it needs the
    // started Slack adapter, the same disjoint-valid-range shape as
    // workerPool.start().
    offsetOf("setAuditRoutingControl(");
    // KPR-452, second half of the SAME wiring: the channel NAME is also a
    // spawn-read fact, and CLAUDE.md documents both calls as above-boundary
    // wiring — but only the control was pinned (child-PR integration round,
    // CONSIDER 2). The off-window is degraded-OFF rather than wrong-destination
    // (rule 4 misses, one warn per turn, no copy), which is why it is a pin and
    // not a redesign: a refactor that moved this below the Slack-dependent
    // `dispatcher.setAuditChannel(...)` would leave all seven other anchors
    // green while the mirror silently stopped mirroring.
    offsetOf("dispatcher.setAuditChannelName(");
    // KPR-454: the ops publisher is a spawn-read surface (the first turn
    // after boot can fail a tool), so both anchors are order-pinned below.
    offsetOf("await opsPublisher.init()");
    offsetOf("setOpsPublisher(");
    // KPR-468: the ops notifier's intake is a spawn-read surface (D6 names an
    // agent tool call among the inbound acknowledgement edges KPR-455 will
    // build), so both anchors are order-pinned below.
    offsetOf("await opsNotifier.init()");
    offsetOf("setOpsNotifier(");
    offsetOf("await bgTaskManager.start()");
    offsetOf("await bgTaskManager.scanOrphans()");
    offsetOf("await codeTaskManager.start()");
    offsetOf("await slackAdapter.start(");
    offsetOf("await smsAdapter.start(");
    offsetOf("scheduler.start()");
  });

  it("(b) wiring precedes every named spawn-capable surface", () => {
    const wiringOffsets = [
      offsetOf("agentManager.setWorkerPool("),
      offsetOf("await workerPool.ensureIndexes()"),
      offsetOf("dispatcher.setMeetingScribe("),
      offsetOf("dispatcher.setMeetingAckEnabled("),
      offsetOf("dispatcher.setAuditChannelName("),
      offsetOf("setAuditRoutingControl("),
      offsetOf("await opsPublisher.init()"),
      offsetOf("setOpsPublisher("),
      offsetOf("await opsNotifier.init()"),
      offsetOf("setOpsNotifier("),
    ];
    const surfaceOffsets = [
      offsetOf("await bgTaskManager.start()"),
      offsetOf("await bgTaskManager.scanOrphans()"),
      offsetOf("await codeTaskManager.start()"),
      offsetOf("await slackAdapter.start("),
      offsetOf("await smsAdapter.start("),
      offsetOf("scheduler.start()"),
    ];
    const maxWiring = Math.max(...wiringOffsets);
    const minSurface = Math.min(...surfaceOffsets);
    expect(maxWiring).toBeLessThan(minSurface);
  });

  it("(c) no unallowlisted spawn-capable start precedes the wiring (superset sweep)", () => {
    // Bounded by the LATEST wiring anchor, not the first — a surface
    // introduced between setWorkerPool and setMeetingScribe is still above
    // the wiring block and must be caught, not silently inside the "already
    // wired" region. Empirically confirmed (pre-PR review): using only the
    // first anchor let an inserted `.start()` call between the two existing
    // anchors pass all three tests green.
    const wiringStart = Math.max(
      offsetOf("agentManager.setWorkerPool("),
      offsetOf("await workerPool.ensureIndexes()"),
      offsetOf("dispatcher.setMeetingScribe("),
      offsetOf("dispatcher.setMeetingAckEnabled("),
      offsetOf("dispatcher.setAuditChannelName("),
      offsetOf("setAuditRoutingControl("),
      offsetOf("await opsPublisher.init()"),
      offsetOf("setOpsPublisher("),
      offsetOf("await opsNotifier.init()"),
      offsetOf("setOpsNotifier("),
    );
    // Known non-spawn-capable `.start(`/`.scanOrphans(` calls that legitimately
    // precede the wiring. Adding to this list is a deliberate, reviewed
    // classification decision — not a way to silence a real finding.
    const allowlist = ["dbIdentityMonitor.start(", "contactsWatcher.start("];
    // Round-1 child-PR review found and empirically confirmed that a
    // preceding-context window (`codeOnly.slice(match.index - 40, ...)`)
    // let a genuine offender placed immediately after an allowlisted call
    // (e.g. on the very next line) silently pass — the allowlisted string
    // was still inside the new match's own 40-char window. Matching the
    // receiver exactly (round 1's fix) closed that, but round 2 found the
    // exact-identifier regex was too narrow the OTHER way: a receiver that
    // isn't a bare identifier — `x?.start()`, `x!.start()`, `new X().start()`,
    // `arr[0].start()`, `getX().start()` — produced NO match at all, so it
    // was invisible rather than misclassified. index.ts already uses `?.`
    // for conditionally-constructed surfaces (`voiceAdapter?.stop()`,
    // `meetingMonitor?.stop()`, etc.), so a future `newSurface?.start()` in
    // the file's own idiom would have slipped past silently. The alternation
    // below accepts a bare identifier (captured) OR the tail of a call/index/
    // non-null expression (`)`, `]`, `!`), with an optional `?` before the
    // dot for optional chaining — every receiver shape either resolves to a
    // real identifier or normalizes to the un-allowlistable `<expr>.method(`.
    const pattern = /(?:([A-Za-z_$][\w$]*)|[)\]!])\s*\??\.\s*(start|scanOrphans)\s*\(/g;
    let match: RegExpExecArray | null;
    const offenders: string[] = [];
    while ((match = pattern.exec(codeOnly)) !== null) {
      if (match.index >= wiringStart) continue; // only care about matches BEFORE the wiring
      const call = `${match[1] ?? "<expr>"}.${match[2]}(`;
      if (allowlist.includes(call)) continue;
      offenders.push(call);
    }
    expect(
      offenders,
      "an unallowlisted spawn-capable start/scanOrphans precedes the wiring — classify it (allowlist if inert, move the wiring if not)",
    ).toEqual([]);
  });

  it("(d) index.ts never calls opsPublisher.start( — (c)'s allowlist needs no entry (KPR-454 AC13)", () => {
    // The drainer is demand-driven and the subscription-reload timer is armed
    // inside init(), so there is no start() to call and (c)'s allowlist needs
    // no publisher entry. A later refactor introducing `opsPublisher.start(`
    // in index.ts must either place it AFTER the wiring anchors or add it to
    // that allowlist under the reviewed-classification discipline the list's
    // own comment demands. Scope: this scans index.ts, not src/ops/.
    expect(codeOnly).not.toContain("opsPublisher.start(");
  });

  it("(e) the ops queue drains BEFORE Slack and Mongo close (KPR-454 D10)", () => {
    // The other end of the publisher's lifecycle, and the half nothing held.
    // `stop()`'s OWN bound — reload timer cleared first, drain within
    // SHUTDOWN_DRAIN_MS, stops accepting — is pinned in
    // publisher.integration.test.ts; "before slackAdapter.stop() and
    // mongoClient.close()" is an index.ts ORDERING fact that no test read, so
    // relocating the call below `await mongoClient.close()` left the whole
    // suite green (measured). It matters because the drain's queued inserts
    // need a live Mongo client: after the close they would all fault, turning
    // a bounded drain into a silent loss of every queued event.
    //
    // Sliced from the shutdown handler, so an `opsPublisher.stop()` written
    // anywhere else in the file could not satisfy it. Modelled on the KPR-456
    // group's drain case below.
    const shutdown = codeOnly.slice(offsetOf("const shutdown = async"));
    const stop = shutdown.indexOf("await opsPublisher.stop()");
    expect(stop, "opsPublisher.stop() is not called from the shutdown handler").toBeGreaterThanOrEqual(0);
    for (const later of ["await slackAdapter.stop()", "await mongoClient.close()"]) {
      const at = shutdown.indexOf(later);
      expect(at, `shutdown anchor not found: ${later}`).toBeGreaterThanOrEqual(0);
      expect(at, `${later} must run AFTER the ops queue drains`).toBeGreaterThan(stop);
    }
  });

  it("(f) opsNotifier.start( follows the wiring, so (c)'s allowlist needs no entry (KPR-468 AC14)", () => {
    // Scope: this scans index.ts, not src/ops/. A later refactor that moves
    // `await opsNotifier.start()` above the wiring must either move it back or
    // add it to (c)'s allowlist under the reviewed-classification discipline
    // that list's own comment demands.
    const wiringStart = Math.max(offsetOf("await opsNotifier.init()"), offsetOf("setOpsNotifier("));
    expect(offsetOf("await opsNotifier.start()")).toBeGreaterThan(wiringStart);
  });
});

describe("KPR-456 obligation readiness and drain order", () => {
  const code = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  function at(text: string): number {
    const offset = code.indexOf(text);
    expect(offset, "missing lifecycle anchor " + text).toBeGreaterThanOrEqual(0);
    return offset;
  }
  it("initializes outside optional turn logging and wires every spawn before use", () => {
    expect(at("await obligations.init()")).toBeLessThan(at("if (config.activity.enabled)"));
    expect(at("await obligations.init()")).toBeLessThan(at("agentManager.setDeliveryObligations(obligations)"));
    for (const surface of [
      "await bgTaskManager.start()",
      "await bgTaskManager.scanOrphans()",
      "await codeTaskManager.start()",
      "await slackAdapter.start(",
      "scheduler.start()",
    ])
      expect(at("agentManager.setDeliveryObligations(obligations)")).toBeLessThan(at(surface));
    expect(at("await obligations.start(")).toBeGreaterThan(at("await slackAdapter.start("));
  });
  it("drains obligations before closing Slack or Mongo", () => {
    const shutdown = code.slice(at("const shutdown = async"));
    const stop = shutdown.indexOf("await obligations.stop()");
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(shutdown.indexOf("await slackAdapter.stop()")).toBeGreaterThan(stop);
    expect(shutdown.indexOf("await mongoClient.close()")).toBeGreaterThan(stop);
  });
});

describe("KPR-468 ops notifier readiness and drain order", () => {
  const code = readFileSync(fileURLToPath(new URL("./index.ts", import.meta.url)), "utf8")
    .split("\n")
    .map((line) => line.replace(/\/\/.*$/, ""))
    .join("\n");
  function at(text: string): number {
    const offset = code.indexOf(text);
    expect(offset, "missing lifecycle anchor " + text).toBeGreaterThanOrEqual(0);
    return offset;
  }

  it("registers the singleton before every spawn-capable surface", () => {
    for (const surface of [
      "await bgTaskManager.start()",
      "await bgTaskManager.scanOrphans()",
      "await codeTaskManager.start()",
      "await slackAdapter.start(",
      "scheduler.start()",
    ])
      expect(at("setOpsNotifier(")).toBeLessThan(at(surface));
  });

  it("binds the transport before starting the sweep, and starts it after the adapters", () => {
    expect(at("opsNotifier.registerTransport(")).toBeLessThan(at("await opsNotifier.start()"));
    expect(at("await opsNotifier.start()")).toBeGreaterThan(at("dispatcher.registerAdapter(slackAdapter)"));
    expect(at("await opsNotifier.start()")).toBeGreaterThan(at("await slackAdapter.start("));
  });

  it("drains the notifier before closing Slack or Mongo", () => {
    const shutdown = code.slice(at("const shutdown = async"));
    const stop = shutdown.indexOf("await opsNotifier.stop()");
    expect(stop).toBeGreaterThanOrEqual(0);
    expect(shutdown.indexOf("await slackAdapter.stop()")).toBeGreaterThan(stop);
    expect(shutdown.indexOf("await mongoClient.close()")).toBeGreaterThan(stop);
  });

  it("adds no second SIGUSR1 listener", () => {
    expect(code.split('process.on("SIGUSR1"').length - 1).toBe(1);
  });
});
