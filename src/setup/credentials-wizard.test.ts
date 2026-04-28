import { describe, it, expect, vi } from "vitest";
import { runCredentialsStage, type CredentialsWizardIO } from "./credentials-wizard.js";
import { CREDENTIAL_REGISTRY } from "./credential-registry.js";

interface TestIO extends CredentialsWizardIO {
  stored: Record<string, string>;
  logs: string[];
}

function makeIO(answers: { ask?: string[]; askSecret?: string[]; confirm?: boolean[] } = {}): TestIO {
  const stored: Record<string, string> = {};
  const logs: string[] = [];

  let askIdx = 0;
  let askSecretIdx = 0;
  let confirmIdx = 0;

  const ask = vi.fn(async () => answers.ask?.[askIdx++] ?? "");
  const askSecret = vi.fn(async () => answers.askSecret?.[askSecretIdx++] ?? "");
  const confirm = vi.fn(async () => answers.confirm?.[confirmIdx++] ?? false);

  return {
    ask,
    askSecret,
    confirm,
    log: (m: string) => logs.push(m),
    setSecret: (k: string, v: string) => {
      stored[k] = v;
    },
    hasSecret: (k: string) => k in stored,
    stored,
    logs,
  };
}

const TOTAL_PROMPTS = CREDENTIAL_REGISTRY.length * 2; // upper bound on confirm prompts per pass

describe("runCredentialsStage", () => {
  it("all-skip path produces no stored secrets and never throws", async () => {
    const confirms = new Array(TOTAL_PROMPTS).fill(false);
    const io = makeIO({ confirm: confirms });
    const result = await runCredentialsStage(io);
    expect(Object.keys(io.stored)).toEqual([]);
    expect(result.configured).toEqual([]);
    expect(result.skipped.length).toBeGreaterThan(0);
    // sanity: every registry entry got classified somewhere
    expect(result.configured.length + result.skipped.length).toBe(CREDENTIAL_REGISTRY.length);
  });

  it("provides keys for two entries when operator says yes + supplies values", async () => {
    // Confirm answers, in order:
    //   brave-search: "Provide a key now?" → yes
    //   linear:       "Provide a key now?" → yes
    //   then no for all remaining (incl. oauth ack: doesn't matter)
    const confirms: boolean[] = [true, true];
    while (confirms.length < TOTAL_PROMPTS) confirms.push(false);

    const io = makeIO({
      askSecret: ["brave-key-value", "linear-key-value"],
      confirm: confirms,
    });
    const result = await runCredentialsStage(io);

    expect(io.stored).toEqual({
      BRAVE_API_KEY: "brave-key-value",
      LINEAR_API_KEY: "linear-key-value",
    });
    expect(result.configured).toContain("brave-search");
    expect(result.configured).toContain("linear");
  });

  it("empty input skips that entry without aborting", async () => {
    const confirms: boolean[] = [true]; // brave: provide → yes
    while (confirms.length < TOTAL_PROMPTS) confirms.push(false);

    const io = makeIO({
      askSecret: [""], // empty value
      confirm: confirms,
    });
    const result = await runCredentialsStage(io);

    expect(io.stored).toEqual({});
    expect(result.skipped).toContain("brave-search");
  });

  it("oauth entries (google) record as skipped and never call setSecret", async () => {
    const confirms = new Array(TOTAL_PROMPTS).fill(false);
    const io = makeIO({ confirm: confirms });
    const result = await runCredentialsStage(io);
    expect(result.skipped).toContain("google");
    // No keys stored from google entry — there are no fields
    for (const k of Object.keys(io.stored)) {
      expect(k.startsWith("GOOGLE")).toBe(false);
    }
  });

  it("already-configured + decline-replace marks server as configured (not re-prompted)", async () => {
    const io = makeIO({ confirm: new Array(TOTAL_PROMPTS).fill(false) });
    // Pre-seed: brave is already configured. hasSecret reads from stored.
    io.stored.BRAVE_API_KEY = "existing";

    const result = await runCredentialsStage(io);
    expect(result.configured).toContain("brave-search");
    expect(io.stored.BRAVE_API_KEY).toBe("existing");
  });

  it("setSecret failure surfaces as skipped, not thrown", async () => {
    const confirms: boolean[] = [true]; // brave: provide
    while (confirms.length < TOTAL_PROMPTS) confirms.push(false);

    const io: TestIO = {
      ...makeIO({ askSecret: ["whatever"], confirm: confirms }),
    };
    io.setSecret = () => {
      throw new Error("simulated honeypot failure");
    };

    const result = await runCredentialsStage(io);
    expect(result.skipped).toContain("brave-search");
    expect(result.configured).not.toContain("brave-search");
  });
});
