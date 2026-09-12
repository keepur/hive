import { z } from "zod";
import type { DetailKeySpec, OpsReason } from "./types.js";
import {
  OPS_DETAIL_STRING_MAX,
  OPS_LOG_ANOMALY_VALUE_MAX,
  OPS_REMEDIATION_MAX,
  OPS_TOKEN_RE,
  clipForLog,
} from "./ids.js";

/** D1: the engine itself, reporting what it observed. A bounded token, never an enum member. */
export const HIVE_RUNTIME_PRODUCER = "hive-runtime";

export const REASON_TOOL_FAILED = "tool-failed";
export const REASON_TOOL_RECOVERED = "tool-recovered";

/**
 * D5: the two rows this producer ships, both enabled at deploy.
 *
 * ORDER IS LOAD-BEARING (D5): `tool-recovered` is upserted FIRST. Neither
 * order leaves every prefix of the write sequence legal, so the choice is a
 * severity comparison between two illegal middle states. Failure-first would
 * leave a persisted, ENABLED, class:resource row that no registered reason
 * clears — the state D4's enable gate exists to refuse, live and consequential
 * (a condition raised under it could never be cleared: D2's permanent
 * silence). Clearing-first leaves a dangling forward reference that nothing
 * dereferences: `tool-recovered` is informational so nothing selects it, its
 * clearsReasonIds is read only by the gate and by C19's publish-time check,
 * and with `tool-failed` unregistered C5 fails closed on every tool-failed
 * publish so no event carrying a `clears` into that family can exist. A
 * bookkeeping defect beats a silence generator, and the next boot repairs it.
 *
 * DO NOT reorder this array.
 */
export const HIVE_RUNTIME_REASONS: readonly OpsReason[] = [
  {
    producer: HIVE_RUNTIME_PRODUCER,
    reasonId: REASON_TOOL_RECOVERED,
    class: "informational",
    retry: "transient",
    clearsReasonIds: [REASON_TOOL_FAILED],
    // D6: `agentId` is deliberately ABSENT. The only agent slug reachable on
    // the recovery path belongs to the arbitrary later turn whose success
    // triggered it — the same stranger whose work item this producer refuses
    // as evidence and whose waiter it refuses in favour of a fixed
    // `waiting: "nobody"`. `lane` survives: it names the capture point that
    // observed the success, a property of the observation, attributed to
    // nobody.
    detailKeys: [
      { key: "tool", type: "string", maxLength: 200 },
      { key: "lane", type: "string", maxLength: 16 },
    ],
    remediationTemplate: "none; recorded so {tool} reopens as a new epoch if it returns",
    enabled: true,
  },
  {
    producer: HIVE_RUNTIME_PRODUCER,
    reasonId: REASON_TOOL_FAILED,
    class: "resource",
    // D5: the honest default for a mixed population — a tool that failed once
    // may succeed on the same input. D3's stated lever for a genuinely
    // deterministic class is a SECOND reasonId, never a per-event assertion.
    retry: "transient",
    detailKeys: [
      { key: "tool", type: "string", maxLength: 200 },
      { key: "errorSig", type: "string", maxLength: 32 },
      { key: "agentId", type: "string", maxLength: 64, optional: true },
      { key: "lane", type: "string", maxLength: 16 },
      { key: "threadId", type: "string", maxLength: 200, optional: true },
      { key: "workItemId", type: "string", maxLength: 200, optional: true },
      { key: "durationMs", type: "number", optional: true },
    ],
    // D5: interpolates ONLY always-present keys. {agentId} is excluded because
    // it is absent on exactly the detached worker and scribe rows this design
    // calls its most valuable case, and a template naming it would render a
    // hole there and force KPR-468 to invent an optional-parameter rendering
    // rule this ticket has no reason to specify.
    remediationTemplate: "retry {tool}; if it repeats, inspect its {errorSig} failures on lane {lane}",
    enabled: true,
  },
];

/**
 * D4: the bound on a detail KEY NAME. Deliberately NOT `OPS_TOKEN_RE` — that
 * is lowercase-hyphen and would reject this producer's own `errorSig`,
 * `workItemId` and `durationMs`. A key name rides into every stored document
 * for its reason, so an unbounded one is the hole `maxLength` closes for
 * values, still open from the other side.
 */
const DETAIL_KEY_NAME_RE = /^[A-Za-z][A-Za-z0-9_]{0,63}$/;

/**
 * The three normalizations `compileDetailSchema` performs SILENTLY on a
 * data-sourced row, returned as anomaly strings. PURE — decides nothing.
 * `assertReasonTableLegal` throws on its output (code-resident half, a
 * development-time defect); chunk 3's `loadReasons` warns and counts on it
 * (data-sourced half, where refusing the row would let one operator row disable
 * publishing). All three already fail CLOSED, so this is strictly diagnostic:
 * it separates "this row declares something the engine narrows" from "the
 * producer is mis-integrated", which the bare `rejected` counter cannot.
 *
 * ⚠ EVERY INTERPOLATED VALUE IS CLIPPED, AT THE SOURCE (C13). All of them —
 * `row.producer`, `row.reasonId`, `spec.key`, `spec.type`, and `spec.maxLength`
 * on the clamp arm — come from an `ops_reasons` document this engine did not
 * author, and NOTHING on the load path validates them (deliberately: D5 loads
 * whatever the collection holds). `loadReasons` writes these strings into the
 * boot log up to `REASON_ROW_ANOMALY_LOG_MAX` times per row, and row count is
 * unbounded, so bounding the COUNT of those lines (round 2) while leaving their
 * WIDTH open still let one hand-edited collection write arbitrary megabytes to
 * the log on every boot. The internal inconsistency that named it: the tally
 * line two statements later in `loadReasons` is annotated "C13: ... No anomaly
 * text." and clips `row._id`, while the five lines above it printed unbounded
 * foreign text.
 *
 * ⚠ AND CLIPPING HERE COSTS `assertReasonTableLegal`'s THROWS NOTHING — the
 * tension an earlier round escalated rather than resolved. Both clipped values
 * have code-declared legal maxima well under the bound: `DETAIL_KEY_NAME_RE`
 * admits at most 64 characters, and `type` is one of three literals (<= 7). So
 * for every input where the throw's actionability matters the value is already
 * legal and `OPS_LOG_ANOMALY_VALUE_MAX` (80) never fires; where it DOES fire the
 * name is by definition illegal and the message already says so ("key NAME
 * fails /^[A-Za-z].../"), and its first 80 characters identify it completely.
 * No input costs a developer anything.
 */
export function auditReasonRow(row: OpsReason): string[] {
  const anomalies: string[] = [];
  for (const spec of row.detailKeys) {
    // Clipped BEFORE `JSON.stringify`, not after: stringifying first would
    // materialise the whole foreign value as a new string only to throw it
    // away, and `clipForLog` is `String()`-total for the non-string a
    // hand-edited row can put here. `JSON.stringify` still runs — it is doing
    // the QUOTING/ESCAPING, so a key bearing a newline or a quote cannot
    // reshape the log line.
    const keyText = JSON.stringify(clipForLog(spec.key, OPS_LOG_ANOMALY_VALUE_MAX));
    const id = `${clipForLog(row.producer)}:${clipForLog(row.reasonId)} key ${keyText}`;
    if (!DETAIL_KEY_NAME_RE.test(spec.key)) {
      anomalies.push(`${id}: key NAME fails ${String(DETAIL_KEY_NAME_RE)}`);
    }
    if (spec.type !== "string" && spec.type !== "number" && spec.type !== "boolean") {
      // compileDetailSchema's if/else chain has no default arm, so a foreign
      // "date" or a typo'd "String" silently compiles to z.boolean().
      anomalies.push(
        `${id}: unrecognized type ${JSON.stringify(clipForLog(spec.type, OPS_LOG_ANOMALY_VALUE_MAX))} — compiled as boolean`,
      );
    }
    if (spec.type === "string" && spec.maxLength !== undefined && spec.maxLength > OPS_DETAIL_STRING_MAX) {
      // `maxLength` is typed `number` and is not one either: a digit-string
      // from a hand-edited row passes the `>` comparison by numeric coercion
      // (a long one coerces to Infinity), so this arm is reachable carrying an
      // arbitrarily wide value.
      anomalies.push(
        `${id}: declares maxLength ${clipForLog(spec.maxLength, OPS_LOG_ANOMALY_VALUE_MAX)}, ` +
          `clamped to ${OPS_DETAIL_STRING_MAX}`,
      );
    }
  }
  return anomalies;
}

/**
 * D4's enable gate, as a PURE precondition over the code-resident table.
 * Evaluated before any I/O; a violation is a development-time throw, never an
 * operational boot fault. `informational` reasons are exempt (no clearing
 * act); `judgment` and `integrity` are deliberately not gated (their clearing
 * acts are human-originated and may legitimately be registered later).
 *
 * Also enforces D4's separate registration clause: a row naming an
 * unregistered reason in clearsReasonIds is rejected at registration.
 */
export function assertReasonTableLegal(rows: readonly OpsReason[]): void {
  const ids = new Set(rows.map((r) => `${r.producer}:${r.reasonId}`));
  for (const row of rows) {
    if (!OPS_TOKEN_RE.test(row.producer) || !OPS_TOKEN_RE.test(row.reasonId)) {
      throw new Error(`ops reason table: unbounded token in ${row.producer}:${row.reasonId}`);
    }
    if (row.remediationTemplate.length === 0 || row.remediationTemplate.length > OPS_REMEDIATION_MAX) {
      throw new Error(
        `ops reason table: ${row.reasonId}'s remediationTemplate is empty or exceeds ${OPS_REMEDIATION_MAX} ` +
          `(D4: required, no default, "a bounded parameterised string")`,
      );
    }
    // C13: the allow-list IS the redaction boundary, so a string key with no
    // declared bound is a development-time defect and refuses loudly here.
    // The DATA-sourced half is handled differently and deliberately — see
    // compileDetailSchema below.
    //
    // ⚠ ORDER IS LOAD-BEARING: this range check runs BEFORE the auditReasonRow
    // loop below, so a code-resident row declaring an over-ceiling maxLength
    // gets the precise `outside 1..${OPS_DETAIL_STRING_MAX}` message (the legal
    // range a developer must fix to) rather than auditReasonRow's `clamped to
    // ${OPS_DETAIL_STRING_MAX}` phrasing, which describes what the DATA-sourced
    // path does with such a row and is the wrong diagnostic for a table that is
    // about to throw. Keeping this first is also what keeps the upper-bound arm
    // reachable at all: with the audit loop first it could never fire, and only
    // the `< 1` arm would be live. Chunk 2b's "refuses a maxLength above the
    // ceiling" case pins this ordering — reorder these two blocks and it fails.
    for (const spec of row.detailKeys) {
      if (spec.type !== "string") continue;
      const id = `${row.producer}:${row.reasonId} key "${spec.key}"`;
      if (spec.maxLength === undefined) {
        throw new Error(`ops reason table: ${id} is type "string" with no maxLength (D4: required)`);
      }
      if (spec.maxLength < 1 || spec.maxLength > OPS_DETAIL_STRING_MAX) {
        throw new Error(
          `ops reason table: ${id} declares maxLength ${spec.maxLength}, outside 1..${OPS_DETAIL_STRING_MAX}`,
        );
      }
    }
    // The three silent normalizations, LOUD for the code-resident half. A
    // developer fixes these before deploy, so there is no reason to let the
    // table ship with a key name or a type the compiler will quietly reshape.
    // Runs AFTER the string-bound block above (see the ordering note there), so
    // in practice it is the key-NAME and unrecognized-type arms that fire here;
    // the maxLength-clamp anomaly is this function's contribution to chunk 3's
    // data-sourced `loadReasons` warn path, not to this throw path.
    for (const anomaly of auditReasonRow(row)) {
      throw new Error(`ops reason table: ${anomaly}`);
    }
    for (const cleared of row.clearsReasonIds ?? []) {
      if (!ids.has(`${row.producer}:${cleared}`)) {
        throw new Error(
          `ops reason table: ${row.producer}:${row.reasonId} clears unregistered reason "${cleared}" (D4 registration clause)`,
        );
      }
    }
  }
  for (const row of rows) {
    if (!row.enabled || row.class !== "resource") continue;
    const cleared = rows.some((r) => r.producer === row.producer && (r.clearsReasonIds ?? []).includes(row.reasonId));
    if (!cleared) {
      throw new Error(
        `ops reason table: class:resource reason ${row.producer}:${row.reasonId} is enabled but no registered reason ` +
          `lists it in clearsReasonIds — D2's recovery obligation in enforceable form (C19). Register a clearing ` +
          `reason or ship this row disabled.`,
      );
    }
  }
}

/**
 * D6: redaction IS the schema. The `detail` validator is BUILT FROM the
 * registry row's detailKeys — never a hand-written second schema, or the two
 * drift. Compiled once per row and cached by the caller (the store's reason
 * map holds the compiled schema beside the row).
 *
 * Strict: an unknown key, a wrong scalar type, an over-length value or a
 * non-scalar all fail, and the accept path rejects + counts (C5, C13).
 *
 * ⚠ THE DATA-SOURCED HALF, decided explicitly. `assertReasonTableLegal` guards
 * only the CODE-RESIDENT table; this compiles whatever `loadReasons()` read
 * out of `ops_reasons`, including a row no engine code contains (D4, AC16),
 * so it cannot rely on the gate having run. It therefore never trusts
 * `spec.maxLength`: a string key is ALWAYS bounded at
 * `Math.min(spec.maxLength ?? OPS_DETAIL_STRING_MAX, OPS_DETAIL_STRING_MAX)`.
 * The two halves fail differently on purpose — a code-resident defect is loud
 * because a developer fixes it before deploy, a data-sourced one is clamped
 * because refusing the row would let one operator (or foreign-producer) row
 * disable publishing, and C13 requires that nothing unbounded is STORED, not
 * that the row be rejected. The clamp bounds the SCHEMA, never a value: an
 * over-length value still fails and the publish is rejected and counted (D4
 * forbids truncating).
 */
export function compileDetailSchema(keys: readonly DetailKeySpec[]): z.ZodType<Record<string, unknown>> {
  const shape: Record<string, z.ZodTypeAny> = {};
  for (const spec of keys) {
    let field: z.ZodTypeAny;
    if (spec.type === "string") {
      field = z.string().max(Math.min(spec.maxLength ?? OPS_DETAIL_STRING_MAX, OPS_DETAIL_STRING_MAX));
    } else if (spec.type === "number") {
      field = z.number().finite();
    } else {
      field = z.boolean();
    }
    shape[spec.key] = spec.optional ? field.optional() : field;
  }
  // .strict() is the allow-list: any key not declared by the row is rejected.
  return z.object(shape).strict() as unknown as z.ZodType<Record<string, unknown>>;
}
