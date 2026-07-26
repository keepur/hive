import { type Collection, type Db } from "mongodb";
import { createLogger } from "../logging/logger.js";
import type { AgentProviderId } from "./provider-adapters/types.js";

const log = createLogger("turn-history-store");

/**
 * KPR-353 (spec §D3): serialized-char budget for one thread's replay history.
 * Constant, not config (simplicity canon). ~50k tokens replayed worst-case;
 * re-billed against subscription quota each turn (documented matrix caveat,
 * offset by the backend's prompt caching).
 */
export const HISTORY_CHAR_BUDGET = 200_000;

/** 7 days — deliberately identical to `sessions` (session-store.ts:56) so a
 *  thread's continuity artifacts age out together. */
const TTL_SECONDS = 7 * 24 * 60 * 60;

interface TurnRecord {
  at: Date;
  /** Opaque Responses input items, stored VERBATIM: the user message item,
   *  every output item from every round (assistant messages, reasoning items
   *  with encrypted_content — provider-opaque ciphertext by design), and the
   *  function_call_output items hive appended. Hive never introspects them;
   *  replay is an exact re-post (§D3). */
  items: unknown[];
}

interface TurnHistoryDoc {
  _id: string; // "{agentId}:{threadId}:{provider}"
  agentId: string;
  threadId: string;
  provider: AgentProviderId;
  turns: TurnRecord[];
  updatedAt: Date;
}

/**
 * KPR-353 (spec §D3): hive-persisted turn history for stateless-replay
 * providers. The codex surface hard-enforces store:false — there is no server
 * handle to persist — so continuity is client-side replay of these records.
 *
 * BREAKER-SAFETY INVARIANT (§D3 — the fail-soft's real reason): every public
 * method is called inside adapter/manager turn paths OUTSIDE the
 * TurnAssemblyError boundary. A raw Mongo throw reaching the adapter's catch
 * would put "connect ECONNREFUSED" into RunResult.error, pattern-match
 * connect-fail (error-classification.ts:74), and count toward the CODEX
 * breaker's trip streak. Therefore: methods NEVER throw and NEVER return
 * Mongo error text — degradation is logged (warn) and invisible to
 * classification (contract-pinned, spec T3).
 *
 * Concurrency: same-thread turns are serialized by AgentManager's per-thread
 * lock, so the read-modify-write in append() is race-free per key.
 */
export class TurnHistoryStore {
  private collection!: Collection<TurnHistoryDoc>;

  constructor(private db: Db) {}

  async init(): Promise<void> {
    this.collection = this.db.collection<TurnHistoryDoc>("provider_turn_history");
    await this.collection.createIndex({ updatedAt: 1 }, { expireAfterSeconds: TTL_SECONDS });
    await this.collection.createIndex({ agentId: 1, threadId: 1 });
  }

  /** Fail-soft wrapper — the session-store withRetry idiom (session-store.ts:71-81). */
  private async withFallback<T>(op: () => Promise<T>, fallback: T, label: string): Promise<T> {
    try {
      return await op();
    } catch (err) {
      log.warn("Turn-history operation failed — degrading soft (KPR-353 §D3)", {
        label,
        error: String((err as { message?: unknown })?.message ?? err),
      });
      return fallback;
    }
  }

  private key(agentId: string, threadId: string, provider: AgentProviderId): string {
    return `${agentId}:${threadId}:${provider}`;
  }

  /**
   * Flattened turn items, oldest-first. [] on miss OR on any Mongo failure —
   * the turn then runs fresh with a warn (continuity degrades for one turn,
   * delivery doesn't).
   */
  async load(agentId: string, threadId: string, provider: AgentProviderId): Promise<unknown[]> {
    return this.withFallback(async () => {
      const doc = await this.collection.findOne({ _id: this.key(agentId, threadId, provider) });
      if (!doc) return [];
      return doc.turns.flatMap((t) => t.items);
    }, [], `load(${agentId}:${threadId}:${provider})`);
  }

  /**
   * Push one turn record + trim; fail-soft void. Trim = WHOLE turns, oldest
   * first, under HISTORY_CHAR_BUDGET — the `turns.length > 1` guard means the
   * newest turn is never trimmed away, so a single over-budget turn is kept
   * whole (spec §D3: a split function_call/function_call_output pair is a
   * malformed replay — whole-turn granularity is the rule).
   */
  async append(agentId: string, threadId: string, provider: AgentProviderId, items: unknown[]): Promise<void> {
    if (items.length === 0) return;
    await this.withFallback(async () => {
      const _id = this.key(agentId, threadId, provider);
      const now = new Date();
      const doc = await this.collection.findOne({ _id });
      const turns: TurnRecord[] = [...(doc?.turns ?? []), { at: now, items }];
      while (turns.length > 1 && JSON.stringify(turns).length > HISTORY_CHAR_BUDGET) {
        turns.shift();
      }
      await this.collection.updateOne(
        { _id },
        { $set: { agentId, threadId, provider, turns, updatedAt: now } },
        { upsert: true },
      );
    }, undefined, `append(${agentId}:${threadId}:${provider})`);
  }

  /**
   * All providers for the thread — provider-agnostic so the KPR-313 handoff
   * hook stays generic (§D4). AWAITED and catch-swallowed at the manager call
   * site; never throws here either (belt and braces). A failed clear is the
   * spec's accepted residual: the stale doc survives until TTL, warn-logged.
   */
  async clear(agentId: string, threadId: string): Promise<void> {
    await this.withFallback(async () => {
      await this.collection.deleteMany({ agentId, threadId });
    }, undefined, `clear(${agentId}:${threadId})`);
  }
}
