# KPR-452 plan — chunk 2: dispatcher rewrite and boot wiring

Read with [the main plan](kpr-452-plan.md). Tasks 3–4.

Tasks 3 and 4 are **one compile unit and one commit**: `setAuditChannel` drops its third parameter in Task 3 and `index.ts:661` is fixed in Task 4. Do not commit between them.

⚠ `index.ts:661` is the only other **production** caller of `setAuditChannel`, but not the only caller in the repo: `src/channels/dispatcher.test.ts:1096`, `:1117` and `:1135` also pass three arguments. That is harmless for the Task 3–4 verification — `tsconfig.json` sets `"exclude": ["node_modules", "dist", "src/**/*.test.ts"]`, so `npm run typecheck` never sees them — and all three sit inside the `describe("per-agent audit routing")` block that Chunk 3 Task 5 replaces wholesale. **The chunk-2 commit therefore leaves `dispatcher.test.ts` red on purpose** (`npx vitest run src/channels/dispatcher.test.ts` will fail on the three homeBase tests until Task 5 lands). Do not "fix" those three call sites here, and do not run the full Integration command as a gate on this commit — Task 4 Step 7's gate is `src/boot-order.test.ts` alone.

## Task 3: Rewrite the Dispatcher's audit path

**Files:**
- Modify: `src/channels/dispatcher.ts` — imports (`:1-40`), fields (`:193-195`), `setAuditChannel` (`:268-272`), call sites (`:528-530`, `:1300-1310`, `:1885-1887`), `postAuditLog` (`:2458-2507`).

⚠ `postAuditLog` ends at **`:2507`**, not `:2508`. `:2508` is the **class's closing brace and the last line of the file** (`wc -l src/channels/dispatcher.ts` = 2508), and the Step 6 replacement text carries the method's `}` but **not** the class brace. Replacing through `:2508` deletes the class terminator and breaks the parse.

- [ ] **Step 1:** Add the leaf import. `policyFor` is already imported from `../outage/outage-notices.js` and stays — it is still used by the outage paths. Insert after the `deadline-continuation.js` import block (ends `dispatcher.ts:40`, the `} from "./deadline-continuation.js";` line):

```typescript
import { auditCopyDecision } from "../audit/audit-routing.js";
```

- [ ] **Step 2:** Replace the three audit fields at `dispatcher.ts:193-195`:

```typescript
  private auditAdapter?: ChannelAdapter;
  private auditChannelIds?: Map<string, string>; // slack channel name → id
  private fallbackAuditChannelId?: string;
```

with:

```typescript
  private auditAdapter?: ChannelAdapter;
  private auditChannelIds?: Map<string, string>; // slack channel name → id
  /**
   * KPR-452 D4: the configured audit channel NAME (`override ?? config
   * .slack.auditChannel`), resolved to an id lazily. Empty string is treated
   * as unset. `homeBase` is no longer an audit destination, and there is NO
   * default recipient — unset means the mirror is off (KPR-456 canon).
   */
  private auditChannelName?: string;
  /** Epoch ms of the last dispatch-path `conversations.list` ATTEMPT. */
  private auditRefreshAt = 0;
  /**
   * Single-flight guard for the dispatch-path refresh. Always holds an
   * already-terminated promise (the IIFE below catches internally), so every
   * awaiter sees a resolution and no rejection escapes.
   */
  private auditRefreshInFlight?: Promise<void>;
```

- [ ] **Step 3:** Add the refresh interval beside the existing dedup constant (`dispatcher.ts:227`, `private static readonly DEDUP_TTL_MS = 60_000;`):

```typescript
  /** KPR-452 D4: dispatch-path channel-map refresh floor. */
  private static readonly AUDIT_REFRESH_INTERVAL_MS = 60_000;
```

- [ ] **Step 4:** Replace `setAuditChannel` (`dispatcher.ts:268-272`) with the new setter set, in this order:

```typescript
  /**
   * KPR-452 D4: Slack-dependent activation. Wired at index.ts's existing
   * site, BELOW the spawn-capable boundary, because it needs the started
   * Slack adapter. The routing CONTROL and `setAuditChannelName` are wired
   * above the boundary — wiring above, activation below, the same
   * disjoint-valid-range shape as `workerPool.start()`. A turn landing
   * between the two sees `auditAdapter` unset and `postAuditLog` returns at
   * D2 rule 1, exactly as today.
   *
   * The third parameter (`fallbackChannelId`) is GONE — the dispatcher no
   * longer holds a fallback id, because there is no longer a primary
   * (homeBase) destination for it to be a fallback to.
   */
  setAuditChannel(adapter: ChannelAdapter, channelIdByName: Map<string, string>): void {
    this.auditAdapter = adapter;
    this.auditChannelIds = channelIdByName;
  }

  /** KPR-452 D4: the effective audit channel name. Empty ⇒ unset ⇒ mirror off. */
  setAuditChannelName(name: string | undefined): void {
    const trimmed = name?.trim();
    this.auditChannelName = trimmed ? trimmed : undefined;
  }

  getAuditChannelName(): string | undefined {
    return this.auditChannelName;
  }

  /** Map-only lookup — NEVER issues a Slack call. For `audit_channel_get`. */
  peekAuditChannelId(): string | undefined {
    return this.auditChannelName ? this.auditChannelIds?.get(this.auditChannelName) : undefined;
  }

  /** True once both the audit adapter and the Slack client are wired. */
  auditRoutingReady(): boolean {
    return Boolean(this.auditAdapter && this.auditChannelIds && this.slackAdapter);
  }

  /**
   * KPR-452 D5: the `audit_channel_set` validation path. NOT on any turn's
   * critical path, so — deliberately unlike `refreshAuditChannelIds` below —
   * it paginates FULLY and SEEDS every resolved name→id pair into
   * `auditChannelIds`. The seeding is what makes the tool a working escape
   * for a channel beyond page 1 of the dispatch-path refresh; without it the
   * tool would report success while every subsequent audit post kept failing
   * to resolve until the next boot.
   *
   * Throws on a Slack fault: the caller is the admin tool, which turns that
   * into an honest tool error. No turn is ever on this path.
   */
  async resolveAuditChannelIdFully(name: string): Promise<string | undefined> {
    const client = this.slackAdapter?.client;
    const ids = this.auditChannelIds;
    if (!client || !ids) return undefined;
    let found = ids.get(name);
    let cursor: string | undefined = undefined;
    do {
      const page = await client.conversations.list({
        types: "public_channel,private_channel",
        limit: 1000,
        cursor,
      });
      for (const c of page.channels ?? []) {
        if (c.name && c.id) ids.set(c.name, c.id);
      }
      cursor = page.response_metadata?.next_cursor || undefined;
      found = ids.get(name);
    } while (cursor && !found);
    return found;
  }
```

- [ ] **Step 5:** Add the two private resolver methods immediately above `postAuditLog` (`dispatcher.ts:~2458`):

```typescript
  /** KPR-452 D2 rule 4. Map hit, else one bounded refresh, else undefined. */
  private async resolveAuditChannelId(): Promise<string | undefined> {
    const name = this.auditChannelName;
    if (!name) return undefined;
    const hit = this.auditChannelIds?.get(name);
    if (hit) return hit;
    await this.refreshAuditChannelIds();
    return this.auditChannelIds?.get(name);
  }

  /**
   * KPR-452 D4: bounded dispatch-path refresh so a channel created after boot
   * is usable without a restart. Deliberately unlike boot's fully paginated
   * sweep (index.ts): this runs on the AWAITED dispatch path, and a
   * multi-page sweep would put Slack pagination latency inside a turn's
   * completion. ONE page, cursor NOT followed.
   *
   * ⚠ THIS METHOD IS DELIBERATELY NOT `async`. Everything up to storing
   * `auditRefreshInFlight` runs synchronously, so an N-agent fan-out firing N
   * audit posts concurrently produces ONE refresh, not N. Making it `async`
   * would introduce an await point before the flag is stored and break the
   * single-flight guarantee (AC10).
   *
   * The 60 s stamp is taken BEFORE the call is issued, so a slow or failing
   * refresh cannot be retried at request rate.
   *
   * ⚠ The in-flight promise is stored ALREADY-TERMINATED — the IIFE catches
   * internally and clears itself in a language-level `finally`. Never clear
   * with a bare `p.finally(...)` called for its side effect: `.finally()`
   * returns a DERIVED promise that re-rejects, nothing awaits it, and the
   * cleanup idiom would itself raise an unhandled rejection on the very fault
   * containment exists to absorb.
   *
   * ⚠ `await Promise.resolve();` IS THE IIFE'S FIRST STATEMENT AND IS LOAD-
   * BEARING — do not delete it as noise. Without it, a SYNCHRONOUS throw from
   * `client.conversations.list` (a client misconfigured at construction, a
   * throwing stub) runs the whole IIFE body — `catch`, `finally`, and all —
   * BEFORE `this.auditRefreshInFlight = inFlight` executes. The `finally`'s
   * clear then targets a field that was never set, the assignment lands
   * afterwards, and the field permanently holds a RESOLVED promise: every
   * later call returns at the `if (existing)` early-return and the refresh is
   * dead for the life of the process — precisely the latch D4 forbids. The
   * leading await pushes the body into a microtask, so the assignment always
   * wins the race. Unreachable through the real `@slack/web-api` client and
   * through Chunk 3's `mockRejectedValue`, which is exactly why it must be
   * closed here rather than left to a test to notice.
   *
   * ACCEPTED LIMIT: on a workspace with more than one page of channels a
   * newly created channel outside page 1 will not resolve on this path until
   * the next boot. The operator-facing escape is `audit_channel_set`, whose
   * validation paginates fully and seeds the map.
   */
  private refreshAuditChannelIds(): Promise<void> {
    const existing = this.auditRefreshInFlight;
    if (existing) return existing;
    const ids = this.auditChannelIds;
    const client = this.slackAdapter?.client;
    const name = this.auditChannelName;
    if (!ids || !client || !name) return Promise.resolve();
    const now = Date.now();
    if (now - this.auditRefreshAt < Dispatcher.AUDIT_REFRESH_INTERVAL_MS) return Promise.resolve();
    this.auditRefreshAt = now;
    const inFlight = (async () => {
      // Load-bearing — see the note above. Defers the body past the
      // `this.auditRefreshInFlight = inFlight` assignment below, so a
      // synchronous throw cannot latch the single-flight guard forever.
      await Promise.resolve();
      try {
        const page = await client.conversations.list({ types: "public_channel,private_channel", limit: 1000 });
        for (const c of page.channels ?? []) {
          if (c.name && c.id) ids.set(c.name, c.id);
        }
      } catch (err) {
        log.warn("Audit channel refresh failed", { error: String(err), auditChannel: name });
      } finally {
        this.auditRefreshInFlight = undefined;
      }
    })();
    this.auditRefreshInFlight = inFlight;
    return inFlight;
  }
```

- [ ] **Step 6:** Replace the whole of `postAuditLog` (`dispatcher.ts:2458-2507`) with the block below. ⚠ The range **ends at the method's own closing brace on `:2507`**; `:2508` is the class's closing brace and the file's last line, and the replacement text below deliberately **does not include it** — extending the range to `:2508` deletes the class terminator and breaks the build. (Same failure mode as the `index.ts:642-669` range in Task 4 Step 4, in the opposite direction: there the range's last line *is* the `catch`'s brace and the replacement *does* carry it.)

```typescript
  /**
   * KPR-452: mirror one completed turn into the configured audit channel.
   *
   * ⚠ CONTAINMENT (D4 / AC13) — THIS METHOD NEVER THROWS INTO ITS CALLER.
   * Two of its three call sites are AWAITED inside the `try` whose `catch` is
   * `handleTurnFailure` (`:529` under `:558`; `:1886` under `:1900`), and by
   * the time they run the turn's own delivery has ALREADY LANDED. An
   * unguarded Slack 429 or transport reject would therefore convert an
   * already-delivered turn into a "Something went wrong" failure notice plus
   * a KPR-307 `outage_queue` enqueue — visibly worse than a missing audit
   * copy. Every fault below — name resolution, the lazy `conversations.list`,
   * and `auditAdapter.deliver` alike (the last of which was UNGUARDED
   * pre-KPR-452 and could already fail a delivered turn) — degrades to
   * skip-and-warn with this method resolving normally.
   */
  private async postAuditLog(result: WorkResult): Promise<void> {
    try {
      // D2 rule 1 — no audit adapter. Also covers the boot window before
      // index.ts's `setAuditChannel` runs, below the spawn-capable boundary.
      const auditAdapter = this.auditAdapter;
      if (!auditAdapter) return;

      // D2 rules 2-3 — the SINGLE predicate (audit-routing.ts). Do not
      // re-add a `source.kind` check at any call site.
      if (!auditCopyDecision(result.workItem, auditAdapter.kind).post) return;

      // D2 rule 4 — destination. `agentConfig.homeBase` is NO LONGER read
      // here; the mirror has exactly one destination.
      const channelId = await this.resolveAuditChannelId();
      if (!channelId) {
        log.warn("No audit channel resolved", {
          agentId: result.agentId,
          auditChannel: this.auditChannelName ?? null,
        });
        return;
      }

      // D2 rule 5 — cheap invariant guard, generalizing the old slack-kind-
      // specific self-post check. UNREACHABLE BY CONSTRUCTION, not merely
      // dead under rule 2: no namespace surviving rule 2 ever carries a Slack
      // channel id in `source.id` — `event:` items carry a channel NAME
      // (scheduler.ts:379-386), `team-` items a `team_channels` id
      // (`source.id` at scheduler.ts:432, inside the source block :430-434),
      // and voice/sms/imessage/ws items a call id, phone number or client id.
      // Do not write a test that pretends it fires, and do not count on it to
      // exclude anything.
      if (result.workItem.source.id === channelId) return;

      const agentConfig = this.registry.get(result.agentId);
      const agentName = agentConfig?.name ?? result.agentId;
      const icon =
        result.workItem.source.kind === "sms"
          ? ":phone:"
          : result.workItem.source.kind === "imessage"
            ? ":speech_balloon:"
            : result.workItem.source.kind === "app"
              ? ":iphone:"
              : ":incoming_envelope:";
      const senderDisplay = result.workItem.senderName ?? result.workItem.sender;
      const summary = result.text.length > 300 ? result.text.slice(0, 300) + "..." : result.text;

      const auditItem: WorkItem = {
        id: `audit:${result.workItem.id}`,
        text: `${icon} *${agentName}* handled ${result.workItem.source.kind} from ${senderDisplay}:\n> ${summary}\n_($${result.costUsd.toFixed(3)} · ${(result.durationMs / 1000).toFixed(1)}s)_`,
        source: { kind: "internal", id: channelId, label: "audit" },
        sender: "system",
        timestamp: new Date(),
        // KPR-452 D3: NO `slackThreadTs` / `slackTs`. Under a fixed
        // destination a thread timestamp from a DIFFERENT channel is
        // meaningless — `SlackAdapter.deliver` (slack-adapter.ts:135-137)
        // would thread against a foreign ts. Audit copies post at top level.
        // Everything else about the rendered copy is unchanged.
      };

      await auditAdapter.deliver({
        text: auditItem.text,
        agentId: "system",
        workItem: auditItem,
        costUsd: 0,
        durationMs: 0,
      });
    } catch (err) {
      log.warn("Audit post failed", { agentId: result.agentId, error: String(err) });
    }
  }
```

- [ ] **Step 7:** Reduce the three call sites. The `source.kind` half of each guard is deleted; the `auditAdapter` half stays (it keeps the call cheap and, at the voice site, avoids building a `WorkResult` for nothing). Each call keeps its **position**.

At `dispatcher.ts:528-530` (single-agent dispatch, inside the delivery `else` arm, after `deliverAgentResult`):

```typescript
        // KPR-452 D1: the mirror decision now lives entirely inside
        // postAuditLog (D2 rules 1-5). The `source.kind` predicate that used
        // to sit here is GONE — do not re-add it.
        //
        // POSITION is load-bearing too. This stays inside the delivery `else`
        // arm, after deliverAgentResult, because the sibling isNonResponse
        // and killedReaction arms (:487-501) deliver nothing and post no
        // audit copy today. Hoisting the call above them would newly mirror
        // non-response-suppressed turns and killed round-1 reactions. "One
        // decision point" means one PREDICATE, not a relocated call.
        if (this.auditAdapter) {
          await this.postAuditLog(workResult);
        }
```

At `dispatcher.ts:1300-1310` (voice, fire-and-forget), replace the `if (this.auditAdapter && ctx.workItem.source.kind !== this.auditAdapter.kind) {` header with `if (this.auditAdapter) {`, keep the `WorkResult` construction verbatim, and keep the `.catch` with an updated comment:

```typescript
    if (this.auditAdapter) {
      const workResult: WorkResult = {
        text: result.finalMessage,
        agentId: ctx.agentId,
        workItem: ctx.workItem,
        costUsd: result.usage.costUsd,
        durationMs: result.usage.durationMs,
        error: result.errors[0],
      };
      // KPR-452: fire-and-forget shape preserved. postAuditLog is now
      // contained (D4) and no longer rejects, so this .catch is
      // belt-and-braces rather than the guard.
      this.postAuditLog(workResult).catch((err) => log.warn("Audit post failed (voice)", { error: String(err) }));
    }
```

At `dispatcher.ts:1885-1887` (fan-out / conference):

```typescript
        // KPR-452 D1 — same reduction as the single-dispatch site.
        // `workResult.workItem` IS `effectiveItem`, so the leaf sees the same
        // item the old guard read.
        if (this.auditAdapter) {
          await this.postAuditLog(workResult);
        }
```

- [ ] **Step 8:** Verify. Typecheck will still fail on `index.ts:661` until Task 4 — that is expected.

Run:
```bash
cd /Users/mokie/github/hive-kpr-452-mature && npx prettier --write src/channels/dispatcher.ts && \
  npx tsc --noEmit -p tsconfig.json 2>&1 | grep -v "src/index.ts" | head -20
```

Expected: no diagnostics outside `src/index.ts`. The only remaining error is `src/index.ts(661,…): Expected 2 arguments, but got 3.`

- [ ] **Step 9:** Do not commit yet — Task 4 finishes the compile unit.

---

## Task 4: Wire the control in `index.ts` and pin the boot order

**Files:**
- Modify: `src/index.ts:183`, `src/index.ts:466-473` (insert above the boundary at `:474`), `src/index.ts:642-669`, `src/index.ts:925-927`
- Modify: `src/boot-order.test.ts:40-96`

- [ ] **Step 1:** Add the import beside the other `./…` imports at the top of `src/index.ts`:

```typescript
import {
  AUDIT_ROUTING_DOC_ID,
  createAuditRoutingControl,
  setAuditRoutingControl,
  type AuditRoutingDoc,
} from "./audit/audit-routing.js";
```

- [ ] **Step 2:** Rename the forward declaration at `src/index.ts:183`.

```typescript
  let fallbackAuditId: string | undefined;
```
becomes
```typescript
  // KPR-452 D4/AC11: the boot-resolved `config.slack.auditChannel` id. It is
  // NO LONGER the audit mirror's fallback — its one surviving consumer is
  // RetentionSweeper.report (:925/:927), which posts the retention
  // dry-run/deletion report here and falls back to a log line when it is
  // undefined. ⚠ NAMED DIVERGENCE (spec D4): a runtime `audit_channel_set`
  // moves the audit mirror and does NOT move this report, which keeps
  // following config.slack.auditChannel plus a restart. Repointing it at the
  // runtime resolver would change behavior on a shipped, unrelated surface
  // (KPR-51) and is out of scope. Do not delete this variable.
  let retentionReportChannelId: string | undefined;
```

- [ ] **Step 3:** Insert the routing-control block immediately after the `log.info("Meeting scribe wired", {...});` call that ends at `src/index.ts:472`, and **before** the `// ── Spawn-capable boundary ──` marker at `:474`:

```typescript
  // KPR-452 (D5/D6): audit-mirror routing control. The admin
  // `audit_channel_get` / `audit_channel_set` tools read the module-global
  // accessor PER SPAWN, so this wiring is a spawn-read fact and belongs ABOVE
  // the spawn-capable boundary below — the same engine-wide rule as the
  // worker pool, the scribe and the ack lever (KPR-414). Guarded by
  // src/boot-order.test.ts, which carries `setAuditRoutingControl(` as an
  // anchor in all three of its lists.
  //
  // `dispatcher.setAuditChannel(...)` deliberately stays at its later,
  // Slack-dependent site (:661): wiring above, activation below — the same
  // disjoint-valid-range shape as `workerPool.start()`. A turn landing
  // between the two sees `auditAdapter` unset, so `postAuditLog` returns at
  // D2 rule 1 and the tools report not-ready rather than a wrong answer.
  const auditSettings = db.collection<AuditRoutingDoc>("instance_settings");
  // ⚠ WRAPPED, and the wrapping is load-bearing. Today's audit block sits
  // inside a boot try/catch (:646-669) that degrades to log.warn; this read
  // sits ABOVE the boundary, where nothing catches for it and main().catch
  // exits 1 (:999-1002). An unwrapped findOne would let a transient Mongo
  // fault abort startup over an audit-routing lookup. A failed or unreadable
  // override warns once and falls back to config.slack.auditChannel — exactly
  // D5's no-override precedence. Boot never fails on audit routing.
  let auditOverride: AuditRoutingDoc | null = null;
  try {
    auditOverride = await auditSettings.findOne({ _id: AUDIT_ROUTING_DOC_ID });
  } catch (err) {
    log.warn("Audit routing override read failed — falling back to hive.yaml", { error: String(err) });
  }
  dispatcher.setAuditChannelName(auditOverride?.channelName || config.slack.auditChannel);
  if (!dispatcher.getAuditChannelName()) {
    // D5: NO DEFAULT RECIPIENT (KPR-456 canon). With no configured channel
    // the mirror is simply off — never homeBase, never an operator, never any
    // agent channel. The mirror being off is not repaired by falling back to
    // a channel nobody chose.
    log.warn("Audit mirror is OFF — no audit channel configured", {
      hint: "set slack.auditChannel in hive.yaml (restart), or call the admin audit_channel_set tool",
    });
  }
  setAuditRoutingControl(
    createAuditRoutingControl({
      dispatcher,
      settings: auditSettings,
      roster: () => registry,
      configuredChannel: config.slack.auditChannel,
      initialOverride: auditOverride,
    }),
  );
  log.info("Audit routing wired (KPR-452)", {
    auditChannel: dispatcher.getAuditChannelName() || null,
    source: auditOverride?.channelName ? "runtime override" : config.slack.auditChannel ? "hive.yaml" : "unset",
  });
```

If `roster: () => registry` raises a "used before being assigned" diagnostic, mirror the existing idiom at `src/index.ts:314` and `:622` (`new Set(registry!.listIds())`) and write `roster: () => registry!`. Change nothing else. (`:176-177` is only the forward declaration — `// eslint-disable-next-line prefer-const` plus `let registry: AgentRegistry;` — and carries no `!`.)

- [ ] **Step 4:** Replace the audit block at `src/index.ts:642-669` — the **whole** block, from the `// Audit routing:` comment on `:642` through the closing `}` of its `catch` on `:669`. ⚠ The range includes the trailing `} catch (err) { log.warn("Failed to configure audit channel", …) }` at `:667-669`, and the replacement text below **already contains that catch** — replacing only `:642-666` would leave the original catch behind, duplicate it, and break the build. The `try`/`catch` frame, the pagination loop and the `channelIdByName` map are otherwise unchanged; only the comment, the two audit lines and the log fields change:

```typescript
  // KPR-452: resolve the Slack channel name→id map, then hand it plus the
  // audit adapter to the dispatcher. `homeBase` is NO LONGER an audit
  // destination — the mirror posts every surviving copy to the single
  // configured audit channel, whose NAME was already wired above the
  // spawn-capable boundary. This site is Slack-dependent activation only.
  const channelIdByName = new Map<string, string>();
  try {
    let cursor: string | undefined = undefined;
    do {
      const page = await slack.client.conversations.list({
        types: "public_channel,private_channel",
        limit: 1000,
        cursor,
      });
      for (const c of page.channels ?? []) {
        if (c.name && c.id) channelIdByName.set(c.name, c.id);
      }
      cursor = page.response_metadata?.next_cursor || undefined;
    } while (cursor);
    // AC11: RetentionSweeper.report's destination, resolved once at boot from
    // config.slack.auditChannel. Deliberately NOT the runtime override.
    retentionReportChannelId = config.slack.auditChannel
      ? channelIdByName.get(config.slack.auditChannel)
      : undefined;
    dispatcher.setAuditChannel(slackAdapter, channelIdByName);
    log.info("Audit channel configured", {
      channels: channelIdByName.size,
      auditChannel: dispatcher.getAuditChannelName() || null,
      auditChannelResolved: Boolean(dispatcher.peekAuditChannelId()),
      retentionReportChannel: config.slack.auditChannel || null,
      retentionReportResolved: Boolean(retentionReportChannelId),
    });
  } catch (err) {
    log.warn("Failed to configure audit channel", { error: String(err) });
  }
```

- [ ] **Step 5:** Update the two `RetentionSweeper.report` read sites at `src/index.ts:925` and `:927` — rename only:

```typescript
      if (retentionReportChannelId) {
        await slack
          .postMessage(retentionReportChannelId, text)
          .catch((err) => log.warn("Retention report: Slack post failed", { error: String(err) }));
```

- [ ] **Step 6:** Add the anchor to **all three** lists in `src/boot-order.test.ts`.

In `it("(a) named wiring and surface anchors are all present")`, after the `dispatcher.setMeetingAckEnabled(config.meetingWorkers.ackEnabled)` line (`:55`):

```typescript
    // KPR-452: the audit routing control is a spawn-read fact (the admin
    // audit_channel_get/set tools read the module-global accessor per turn),
    // so its wiring must precede every spawn-capable surface. Note that
    // dispatcher.setAuditChannel(...) deliberately stays BELOW — it needs the
    // started Slack adapter, the same disjoint-valid-range shape as
    // workerPool.start().
    offsetOf("setAuditRoutingControl(");
```

In `it("(b) wiring precedes every named spawn-capable surface")`, add to `wiringOffsets`:

```typescript
      offsetOf("setAuditRoutingControl("),
```

In `it("(c) no unallowlisted spawn-capable start precedes the wiring")`, add to the `Math.max(...)` argument list:

```typescript
      offsetOf("setAuditRoutingControl("),
```

- [ ] **Step 7:** Verify, including the AC12 negative-verify.

```bash
cd /Users/mokie/github/hive-kpr-452-mature && npx prettier --write src/index.ts src/boot-order.test.ts && npm run typecheck && \
  SLACK_APP_TOKEN=test SLACK_BOT_TOKEN=test SLACK_SIGNING_SECRET=test npx vitest run src/boot-order.test.ts
```

Expected: `tsc` exits 0 with no diagnostics; all five boot-order tests pass.

Then negative-verify AC12: cut the whole `setAuditRoutingControl(createAuditRoutingControl({...}));` statement and paste it immediately after `await bgTaskManager.start();`. Re-run the boot-order command.

Expected: **two** failures, both of them the guard working, not breakage.
- `(b) wiring precedes every named spawn-capable surface` — the anchor is now in `wiringOffsets` at an offset past `bgTaskManager.start()`, so `maxWiring < minSurface` fails.
- `(c) no unallowlisted spawn-capable start precedes the wiring (superset sweep)` — `(c)` bounds on `Math.max(...)` of the same wiring anchors, so moving the anchor down pushes `wiringStart` past `bgTaskManager.start(`, which is not in the allowlist and is reported as an offender.

`(a)` still passes: it is presence-only and the anchor still exists somewhere in the file. Do **not** read `(c)`'s failure as collateral damage — a negative-verify that tripped only `(b)` would mean the superset sweep had stopped covering this anchor. Restore the statement to its position above the boundary and re-run; expected exit 0, all five boot-order tests green. Record both outcomes in the child delivery handoff.

- [ ] **Step 8:** Commit Tasks 3 and 4 together.

```bash
git add src/channels/dispatcher.ts src/index.ts src/boot-order.test.ts
git commit -m "feat: route audit copies to one configured channel and contain the audit path"
```
