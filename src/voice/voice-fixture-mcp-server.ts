/**
 * KPR-324 C7 (spec §7): voice-pilot-ONLY test fixture for the mid-call
 * latency-masking T-gates. One tool that sleeps a clamped delay and returns
 * byte-stable canned prose in the spec §6.2 `orders_get` template shape, so
 * T1–T3 (and 322 §14.2's "one lookup pause") can run while W1B (KPR-300,
 * the real `orders` implementation) is parked.
 *
 * This is NOT `orders` and must never ship to a production agent:
 *  - registry load strips it from any non-voice-pilot def (agent-registry.ts)
 *  - AgentRunner refuses to build it for any other agent id (belt)
 *  - it has NO SERVER_CATALOG key (a check-less key would render as a
 *    `configured` capability — spec C8's fake-live trap)
 *
 * Logging: duration + delayMs only — never the canned prose (spec §7).
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import { createLogger } from "../logging/logger.js";

const log = createLogger("voice-fixture-mcp");

/** Spec §7: default 1500ms, HARD CAP 5000ms. Clamp, never error (spec §11). */
export const VOICE_FIXTURE_DEFAULT_DELAY_MS = 1500;
export const VOICE_FIXTURE_MAX_DELAY_MS = 5000;

export function clampFixtureDelay(delayMs: number | undefined): number {
  if (typeof delayMs !== "number" || !Number.isFinite(delayMs)) return VOICE_FIXTURE_DEFAULT_DELAY_MS;
  return Math.min(Math.max(0, Math.floor(delayMs)), VOICE_FIXTURE_MAX_DELAY_MS);
}

/**
 * Byte-stable canned body — the spec §6.2 `orders_get` output template
 * (fixed Acme / 45021 fixture). `poNumber` is echoed for digit-confirmation
 * turns but never changes the data (spec §7 input table).
 *
 * ⚠ Bundle guard: this prose is minified into the shipped engine bundle and
 * scanned by scripts/check-bundle-strings.mjs, whose forbidden list is
 * ["dodi", "hubspot", "cabinet"]. Millwork-flavored fixture data is one
 * synonym away from tripping it — keep the spec's wording ("maple doors",
 * "drawer boxes"). Do NOT write "cabinet doors", and never resolve a guard
 * failure by editing the guard's list.
 */
export function buildFixtureResult(poNumber?: string): string {
  const po = poNumber && poNumber.trim().length > 0 ? poNumber.trim() : "45021";
  return [
    `PO ${po} · Acme Hardware · Open`,
    `Ordered: Aug 1, 2026 · Promised: Aug 28, 2026 · Last receipt: Aug 12, 2026`,
    `Ship to: shop`,
    `Lines:`,
    `- 12 maple doors — 8 received, 4 open`,
    `- 6 drawer boxes — 0 received, 6 open`,
    `Notes: vendor quoted late Friday`,
  ].join("\n");
}

export function createVoiceFixtureMcpServer() {
  return createSdkMcpServer({
    name: "voice-fixture",
    version: "1.0.0",
    tools: [
      tool(
        "voice_fixture_lookup",
        "TEST FIXTURE: look up a purchase order (canned data). Sleeps a fixed delay, then returns a stable PO status. For voice latency-masking tests only.",
        {
          delayMs: z
            .number()
            .optional()
            .describe(
              `Simulated lookup latency in ms (default ${VOICE_FIXTURE_DEFAULT_DELAY_MS}, capped at ${VOICE_FIXTURE_MAX_DELAY_MS})`,
            ),
          poNumber: z.string().optional().describe("PO number to echo back in the canned result (data is fixed)"),
        },
        async ({ delayMs, poNumber }) => {
          // KPR-122 in-process contract: handler exceptions must never crash
          // the hive — try/catch → structured error.
          try {
            const delay = clampFixtureDelay(delayMs);
            const startedAt = Date.now();
            await new Promise((resolve) => setTimeout(resolve, delay));
            log.info("voice_fixture_lookup complete", {
              delayMs: delay,
              durationMs: Date.now() - startedAt,
            });
            return {
              content: [{ type: "text" as const, text: buildFixtureResult(poNumber) }],
            };
          } catch (err) {
            return {
              content: [{ type: "text" as const, text: `backend_unavailable\nfixture error: ${String(err)}` }],
              isError: true,
            };
          }
        },
      ),
    ],
  });
}
