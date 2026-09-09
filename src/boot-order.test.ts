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
    offsetOf("await bgTaskManager.start()");
    offsetOf("await bgTaskManager.scanOrphans()");
    offsetOf("await slackAdapter.start(");
    offsetOf("modelCatalogNotifier.start()");
    offsetOf("await smsAdapter.start(");
    offsetOf("scheduler.start()");
  });

  it("(b) wiring precedes every named spawn-capable surface", () => {
    const wiringOffsets = [
      offsetOf("agentManager.setWorkerPool("),
      offsetOf("await workerPool.ensureIndexes()"),
      offsetOf("dispatcher.setMeetingScribe("),
      offsetOf("dispatcher.setMeetingAckEnabled("),
    ];
    const surfaceOffsets = [
      offsetOf("await bgTaskManager.start()"),
      offsetOf("await bgTaskManager.scanOrphans()"),
      offsetOf("await slackAdapter.start("),
      offsetOf("modelCatalogNotifier.start()"),
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

  it("wires the catalog scanner and notifier to the guarded database at their required lifecycle points", () => {
    expect(codeOnly.match(/\bnew\s+ModelCatalogStore\s*\(/g) ?? []).toHaveLength(1);
    expect(codeOnly.match(/new ModelCatalogStore\s*\(\s*db\s*\)/g) ?? []).toHaveLength(1);
    expect(codeOnly.match(/\bnew\s+ModelCatalogScanner\s*\(/g) ?? []).toHaveLength(1);
    expect(
      codeOnly.match(/new ModelCatalogScanner\s*\(\s*modelCatalogStore\s*,\s*discoverProviderModels\s*\)/g) ?? [],
    ).toHaveLength(1);
    expect(codeOnly.match(/\bmodelCatalogScanner\.start\(\)/g) ?? []).toHaveLength(1);
    expect(codeOnly).not.toMatch(/\bawait\s+modelCatalogScanner\.start\(\)/);
    expect(codeOnly.match(/\bnew\s+ModelCatalogOutbox\s*\(/g) ?? []).toHaveLength(1);
    expect(codeOnly.match(/new ModelCatalogOutbox\s*\(\s*db\s*\)/g) ?? []).toHaveLength(1);
    expect(codeOnly.match(/\bnew\s+ModelCatalogNotifier\s*\(/g) ?? []).toHaveLength(1);
    expect(
      codeOnly.match(/new ModelCatalogNotifier\s*\(\s*modelCatalogOutbox\s*,\s*dispatcher\s*\)/g) ?? [],
    ).toHaveLength(1);
    expect(codeOnly.match(/\bdispatcher\.setCatalogNotificationDefault\s*\(/g) ?? []).toHaveLength(1);
    expect(
      codeOnly.match(/dispatcher\.setCatalogNotificationDefault\(config\.explicitDefaultAgent\)/g) ?? [],
    ).toHaveLength(1);
    expect(codeOnly.match(/\bmodelCatalogNotifier\.start\(\)/g) ?? []).toHaveLength(1);
    expect(codeOnly).not.toMatch(/\bawait\s+modelCatalogNotifier\.start\(\)/);
    expect(codeOnly).not.toMatch(/\bmodelCatalogOutbox\.ensureIndexes\s*\(/);
    expect(codeOnly).not.toMatch(/\bmodelCatalogNotifier\.tick\s*\(/);
    expect(codeOnly).not.toMatch(/\bdispatcher\.(?:prepare|sendPrepared)CatalogNotification\s*\(/);

    const guardedDb = offsetOf("const db = guardDb(rawDb, writeGuard)");
    const pluginActivation = offsetOf("await agentManager.activateProviderPlugins()");
    const meetingWiring = offsetOf("dispatcher.setMeetingAckEnabled(config.meetingWorkers.ackEnabled)");
    const memoryHeartbeat = offsetOf("memoryLifecycleHeartbeat.start()");
    const storeConstruction = offsetOf("const modelCatalogStore = new ModelCatalogStore(db)");
    const scannerConstruction = offsetOf(
      "const modelCatalogScanner = new ModelCatalogScanner(modelCatalogStore, discoverProviderModels)",
    );
    const scannerStart = offsetOf("modelCatalogScanner.start()");
    const registerSlack = offsetOf("dispatcher.registerAdapter(slackAdapter)");
    const setSlack = offsetOf("dispatcher.setSlackAdapter(slackAdapter)");
    const slackStart = offsetOf("await slackAdapter.start(");
    const setNotificationDefault = offsetOf("dispatcher.setCatalogNotificationDefault(config.explicitDefaultAgent)");
    const outboxConstruction = offsetOf("const modelCatalogOutbox = new ModelCatalogOutbox(db)");
    const notifierConstruction = offsetOf(
      "const modelCatalogNotifier = new ModelCatalogNotifier(modelCatalogOutbox, dispatcher)",
    );
    const notifierStart = offsetOf("modelCatalogNotifier.start()");

    expect(guardedDb).toBeLessThan(storeConstruction);
    expect(pluginActivation).toBeLessThan(storeConstruction);
    expect(meetingWiring).toBeLessThan(storeConstruction);
    expect(memoryHeartbeat).toBeLessThan(storeConstruction);
    expect(codeOnly).toMatch(
      /memoryLifecycleHeartbeat\.start\(\);\s*const modelCatalogStore = new ModelCatalogStore\(db\);/,
    );
    expect(storeConstruction).toBeLessThan(scannerConstruction);
    expect(scannerConstruction).toBeLessThan(scannerStart);
    expect(scannerStart).toBeLessThan(slackStart);
    expect(registerSlack).toBeLessThan(slackStart);
    expect(setSlack).toBeLessThan(slackStart);
    expect(slackStart).toBeLessThan(setNotificationDefault);
    expect(meetingWiring).toBeLessThan(notifierStart);
    expect(pluginActivation).toBeLessThan(notifierStart);
    expect(setNotificationDefault).toBeLessThan(outboxConstruction);
    expect(outboxConstruction).toBeLessThan(notifierConstruction);
    expect(notifierConstruction).toBeLessThan(notifierStart);
    expect(codeOnly).toMatch(
      /await slackAdapter\.start\(\(item\) => \{[\s\S]*?\n {2}\}\);\s*dispatcher\.setCatalogNotificationDefault\(config\.explicitDefaultAgent\);\s*const modelCatalogOutbox = new ModelCatalogOutbox\(db\);\s*const modelCatalogNotifier = new ModelCatalogNotifier\(modelCatalogOutbox, dispatcher\);\s*modelCatalogNotifier\.start\(\);/,
    );
  });

  it("stops both catalog lifecycles before the first shutdown await and does not tie them to reload or stopAll", () => {
    const shutdownDeclaration = "const shutdown = async (signal: string) => {";
    const shutdownStart = offsetOf(shutdownDeclaration) + shutdownDeclaration.length;
    const shutdownEnd = offsetOf('process.on("SIGTERM"');
    const shutdownBody = codeOnly.slice(shutdownStart, shutdownEnd);
    const scannerStop = shutdownBody.indexOf("const scannerDrain = modelCatalogScanner.stop()");
    const notifierStop = shutdownBody.indexOf("const notifierDrain = modelCatalogNotifier.stop()");
    const drain = shutdownBody.indexOf("await Promise.all([scannerDrain, notifierDrain])");
    const shutdownLog = shutdownBody.indexOf('log.info("Shutdown signal received"');
    const slackStop = shutdownBody.indexOf("await slackAdapter.stop()");
    const mongoClose = shutdownBody.indexOf("await mongoClient.close()");
    const awaits = [...shutdownBody.matchAll(/\bawait\s+[^;\n]+/g)];

    expect(shutdownBody.trimStart()).toMatch(
      /^const scannerDrain = modelCatalogScanner\.stop\(\);\s*const notifierDrain = modelCatalogNotifier\.stop\(\);\s*await Promise\.all\(\[scannerDrain, notifierDrain\]\);/,
    );
    expect(awaits[0]?.[0]).toBe("await Promise.all([scannerDrain, notifierDrain])");
    expect(scannerStop).toBeLessThan(drain);
    expect(notifierStop).toBeLessThan(drain);
    expect(awaits[1]?.index).toBeGreaterThan(drain);
    expect(scannerStop).toBeLessThan(shutdownLog);
    expect(notifierStop).toBeLessThan(shutdownLog);
    expect(drain).toBeLessThan(slackStop);
    expect(drain).toBeLessThan(mongoClose);
    expect(scannerStop).toBeLessThan(mongoClose);
    expect(shutdownBody.match(/\bmodelCatalogScanner\b/g) ?? []).toHaveLength(1);
    expect(shutdownBody.match(/\bmodelCatalogNotifier\b/g) ?? []).toHaveLength(1);
    expect(codeOnly.match(/\bmodelCatalogScanner\b/g) ?? []).toHaveLength(3);
    expect(codeOnly.match(/\bmodelCatalogNotifier\b/g) ?? []).toHaveLength(3);
    expect(codeOnly.match(/\bmodelCatalogScanner\.stop\(\)/g) ?? []).toHaveLength(1);
    expect(codeOnly.match(/\bmodelCatalogNotifier\.stop\(\)/g) ?? []).toHaveLength(1);

    const reloadStart = offsetOf("const reload = async () => {");
    const reloadEnd = offsetOf("const safeReload = () => {");
    expect(codeOnly.slice(reloadStart, reloadEnd)).not.toContain("modelCatalog");
    const stopAllLine = codeOnly.split("\n").find((line) => line.includes("agentManager.stopAll()"));
    expect(stopAllLine).toBeDefined();
    expect(stopAllLine).not.toContain("modelCatalog");
    const adminStart = offsetOf("let adminApi: AdminApi | undefined");
    const shutdownDeclarationOffset = offsetOf(shutdownDeclaration);
    expect(codeOnly.slice(adminStart, shutdownDeclarationOffset)).not.toMatch(
      /modelCatalog(?:Scanner|Notifier)\.stop\(\)/,
    );
  });
});
