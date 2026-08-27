import { Agent, OpenAIProvider, Runner, tool } from "@openai/agents";
import OpenAI from "openai";
import type { ProviderTurnAssembly } from "./turn-assembly.js";
import type { BridgedTool } from "./tool-bridge.js";
import { LaneBTurnScaffold, type LaneBTurnHarness, type LaneBTurnOutcome } from "./turn-scaffold.js";
import { envValue } from "./oauth-credentials.js";
import { createLogger } from "../../logging/logger.js";

const log = createLogger("openai-adapter");

export interface OpenAIAgentsAdapterOptions {
  name: string;
  assembly: ProviderTurnAssembly;
  model?: string;
  apiKey?: string;
}

interface OpenAIResultLike {
  finalOutput?: unknown;
  lastResponseId?: string;
}

interface OpenAIStreamResultLike extends OpenAIResultLike {
  completed: Promise<void>;
  toTextStream(options: { compatibleWithNodeStreams: true }): AsyncIterable<unknown>;
}

export class OpenAIAgentsAdapter extends LaneBTurnScaffold {
  readonly provider = "openai" as const;

  constructor(private readonly options: OpenAIAgentsAdapterOptions) {
    super({ name: options.name, assembly: options.assembly });
  }

  // Scaffold defaults ARE openai's policies: fallback `request.sessionId ??
  // ""`, bare-fallback interruption sessionId — no session hooks here.

  protected override warnDeadlineExpired(timeoutMs: number): void {
    log.warn("OpenAI turn deadline exceeded — aborting turn", {
      agent: this.options.name,
      timeoutMs,
    });
  }

  /** Preserves openai's pre-migration stringification (coerceFinalOutput —
   *  thrown-null → "" edge), vs the codex/gemini default. */
  protected override errorText(error: unknown): string {
    if (error instanceof Error) return error.message;
    return coerceFinalOutput(error);
  }

  protected async executeTurn(harness: LaneBTurnHarness): Promise<LaneBTurnOutcome> {
    const { request, bridge } = harness;

    // KPR-351 (R1): API-key single path — resolve the client BEFORE
    // connecting tool servers, so persistent misconfig fails in microseconds
    // (auth-before-connect ordering is provider-owned; the scaffold does not
    // sequence it).
    const client = this.buildClient();

    // KPR-348: connect() is fail-soft per server and never throws (§D7).
    const bridged = await bridge.connect();
    const tools = bridged.map((bt) => bindTool(bt));
    const agent = new Agent({
      name: this.options.name,
      instructions: request.systemPromptOverride ?? this.options.assembly.instructions,
      model: this.options.model,
      // KPR-350 (§D2): chaining posture pinned, not defaulted. store:true is
      // the previous_response_id prerequisite; truncation:"auto" is the
      // Lane B compaction analog. Nested KPR-354 delegate constructions
      // share this path deliberately.
      modelSettings: { store: true, truncation: "auto" },
      ...(tools.length > 0 ? { tools } : {}),
    });

    const runOptions = {
      // openai hands maxTurns (0 included) to the SDK — deliberate
      // divergence from the raw-API loop's zero-call short-circuit.
      maxTurns: request.resourceLimits?.maxTurns,
      signal: harness.signal,
      previousResponseId: request.sessionId,
    };

    if (harness.streamed) {
      const result = await this.runWithClient(client, agent, request.prompt, {
        ...runOptions,
        stream: true,
      });
      const text = await this.consumeTextStream(result, request.onStream);
      // #407 quiet-resolve guard: the SDK can resolve an aborted stream
      // quietly instead of throwing — a deadline that landed mid-stream must
      // not surface partial text as a clean success. Resolved through the
      // scaffold (deadlineFired && !aborted ⇒ deadline result).
      if (harness.deadlineFired() && !this.wasAborted) return { kind: "interrupted" };
      return { kind: "success", text, sessionId: this.extractSessionId(result, harness.fallbackSessionId) };
    }

    const result = await this.runWithClient(client, agent, request.prompt, {
      ...runOptions,
      stream: false,
    });
    if (harness.deadlineFired() && !this.wasAborted) return { kind: "interrupted" };
    return {
      kind: "success",
      text: coerceFinalOutput(result.finalOutput),
      sessionId: this.extractSessionId(result, harness.fallbackSessionId),
    };
  }

  private async runWithClient(
    client: OpenAI,
    agent: Agent,
    prompt: string,
    options: { stream: true; maxTurns?: number; signal: AbortSignal; previousResponseId?: string },
  ): Promise<OpenAIStreamResultLike>;
  private async runWithClient(
    client: OpenAI,
    agent: Agent,
    prompt: string,
    options: { stream: false; maxTurns?: number; signal: AbortSignal; previousResponseId?: string },
  ): Promise<OpenAIResultLike>;
  private async runWithClient(
    client: OpenAI,
    agent: Agent,
    prompt: string,
    options:
      | { stream: true; maxTurns?: number; signal: AbortSignal; previousResponseId?: string }
      | { stream: false; maxTurns?: number; signal: AbortSignal; previousResponseId?: string },
  ): Promise<OpenAIResultLike | OpenAIStreamResultLike> {
    const runner = new Runner({
      modelProvider: new OpenAIProvider({ openAIClient: client as never }),
    });
    return (await runner.run(agent, prompt, options as never)) as OpenAIResultLike | OpenAIStreamResultLike;
  }

  /**
   * KPR-351 (R1): API-key single path. The codex-oauth attempt is DELETED —
   * the KPR-348 spike proved the codex subscription token authenticates the
   * chatgpt.com backend only and 401s against api.openai.com Responses, so
   * the attempt could only burn one doomed network round-trip per turn and
   * kept a dead org-affinity hazard alive (KPR-350 §Edge). Mirrors the
   * KPR-352 §D7 Vertex deletion: surface-driven single-path auth.
   * `createCodexOpenAITokenProvider` survives in oauth-credentials.ts — the
   * codex adapter is its consumer. Revisit trigger: OpenAI ever serving
   * Responses under subscription auth is a NEW ticket, not a re-add here.
   */
  private buildClient(): OpenAI {
    const apiKey = this.options.apiKey ?? envValue("OPENAI_API_KEY");
    if (!apiKey) {
      // Message prefix shaped to the auth row's existing `api.?key is not
      // available` alternate (error-classification.ts FAULT_PATTERNS) — keep
      // "OpenAI API key is not available" verbatim so it classifies auth.
      // Remediation: the only working path today is seeding OPENAI_API_KEY in
      // the instance .env + a service restart (.env loads into process.env at
      // boot via dotenv; no Keychain leg exists for this key). `hive credentials add OPENAI_API_KEY`
      // hard-rejects — there is no CREDENTIAL_REGISTRY entry for this key and
      // no config.openai.apiKey resolution yet; registry/Keychain wiring is
      // future work (KPR-350 L0 leg seeds via .env).
      throw new Error(
        "OpenAI API key is not available; set OPENAI_API_KEY in the instance .env and restart — hive credentials add does not carry this key yet",
      );
    }
    // maxRetries 0: single-attempt by design (KPR-306 parity with the gemini
    // and codex adapters) — openai-node defaults to 2 client-internal retries
    // on 408/409/429/5xx/connection faults, which would mask provider faults
    // from breaker classification and inflate llmMs (the breaker's p95 input).
    // Retry policy belongs to the breaker/outage layer.
    return new OpenAI({ apiKey, maxRetries: 0 });
  }

  private async consumeTextStream(result: OpenAIStreamResultLike, onStream?: (chunk: string) => void): Promise<string> {
    let text = "";
    const stream = result.toTextStream({ compatibleWithNodeStreams: true });
    for await (const chunk of stream) {
      const coercedChunk = typeof chunk === "string" ? chunk : String(chunk);
      text += coercedChunk;
      onStream?.(coercedChunk);
    }
    await result.completed;
    return text;
  }

  private extractSessionId(result: OpenAIResultLike, fallback: string): string {
    return result.lastResponseId ?? fallback;
  }
}

/**
 * Bind a provider-neutral BridgedTool to the Agents SDK tool() shape
 * (SPIKE S4/S5): JSON schema passed as parameters with strict:false — the
 * bridge already normalized the schema. errorFunction is belt-and-suspenders
 * (§D3): even an SDK-internal invocation fault becomes model-visible text,
 * not a run-loop rejection.
 */
function bindTool(bt: BridgedTool) {
  return tool({
    name: bt.name,
    description: bt.description,
    parameters: bt.inputSchema as never, // normalized JSON schema, non-strict (spike S4)
    strict: false,
    execute: (input: unknown) => bt.execute(input),
    errorFunction: (_ctx: unknown, err: unknown) =>
      `Tool execution failed (${bt.name}): ${err instanceof Error ? err.message : String(err)}`,
  } as never);
}

export function coerceFinalOutput(output: unknown): string {
  if (typeof output === "string") return output;
  if (output == null) return "";
  try {
    return JSON.stringify(output) ?? String(output);
  } catch {
    return String(output);
  }
}
