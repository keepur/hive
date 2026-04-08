# Voice Pipeline (Vapi) Implementation Plan

> **For agentic workers:** Use dodi-dev:implement to execute this plan.

**Goal:** Give Hive agents real phone call capabilities via Vapi — Claude is the brain, Vapi handles STT/TTS/turn-detection.

**Architecture:** Vapi sends OpenAI-compatible `/chat/completions` requests to a new HTTP server in Hive. We translate to Claude API format, inject the agent's full identity (soul, system prompt, memory), call Claude, and stream back in OpenAI format. A separate MCP server lets agents initiate and monitor calls.

**Tech Stack:** TypeScript, `@anthropic-ai/sdk` (streaming), `@modelcontextprotocol/sdk`, Node HTTP server, Vapi REST API

---

## File Map

| File | Action | Responsibility |
|------|--------|---------------|
| `src/config.ts` | Modify | Add `voice` config block |
| `src/agents/prompt-builder.ts` | Create | Shared `buildVoiceSystemPrompt()` extracted from agent-runner |
| `src/channels/voice/openai-translator.ts` | Create | OpenAI ↔ Claude message format translation |
| `src/channels/voice/voice-adapter.ts` | Create | HTTP server for Vapi `/chat/completions` callbacks |
| `src/voice/voice-mcp-server.ts` | Create | Agent-facing MCP tools: voice_call, voice_call_status, voice_list_calls |
| `src/agents/agent-runner.ts` | Modify | Wire voice MCP server into buildAllServerConfigs() |
| `src/index.ts` | Modify | Start voice adapter, add to shutdown |

---

### Task 1: Configuration

**Files:**
- Modify: `src/config.ts:184-187` (after adminApi block)

- [ ] **Step 1:** Add voice config block to `src/config.ts`

After the `adminApi` block (line 187), add:

```typescript
  voice: {
    enabled: !!hive.voice?.provider,
    provider: (hive.voice?.provider as string) ?? "",
    publicUrl: (hive.voice?.publicUrl as string) ?? "",
    phoneNumberId: (hive.voice?.phoneNumberId as string) ?? "",
    assistants: (hive.voice?.assistants ?? {}) as Record<string, string>,
    apiKey: optional("VAPI_API_KEY", ""),
    serverSecret: optional("VAPI_SERVER_SECRET", ""),
    port: parseInt(optional("VOICE_PORT", String(ports.voice ?? portBase + 5)), 10),
  },
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3:** Commit

```bash
git add src/config.ts
git commit -m "feat(voice): add voice config block (#105)"
```

---

### Task 2: Prompt Builder

**Files:**
- Create: `src/agents/prompt-builder.ts`
- Modify: `src/agents/agent-runner.ts:70-147` (refactor to reuse shared logic)

- [ ] **Step 1:** Create `src/agents/prompt-builder.ts`

Extract the voice-relevant prompt assembly from `AgentRunner.buildSystemPrompt()`. This is a standalone function — no AgentRunner dependency.

```typescript
import type { AgentConfig } from "../types/agent-config.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import { config } from "../config.js";

/**
 * Build a system prompt for voice calls.
 *
 * Assembly order: soul → systemPrompt → constitution → agent memory → date/time (last).
 * Matches the main buildSystemPrompt's static prefix but omits tool summaries and
 * delegate descriptions (those are handled by Vapi's tool layer, not inline prompting).
 */
export async function buildVoiceSystemPrompt(
  agentConfig: AgentConfig,
  memoryManager: MemoryManager,
  callContext?: { goal?: string; context?: string },
): Promise<string> {
  const parts: string[] = [];

  // --- Static prefix ---

  if (agentConfig.soul) {
    parts.push(agentConfig.soul);
  }

  parts.push(agentConfig.systemPrompt);

  // Constitution — non-negotiable team rules
  const constitution = await memoryManager.read("shared/constitution.md");
  if (constitution) {
    parts.push(constitution);
  }

  // Voice-specific instructions
  parts.push(
    `## Voice Call Mode\n\n` +
    `You are currently on a live phone call. Keep responses conversational and concise — ` +
    `you are speaking out loud, not writing text. Avoid markdown, bullet points, or long lists. ` +
    `Speak naturally as a human would on the phone. Identify yourself at the start of the call.`,
  );

  // Call-specific goal/context (injected from voice_call tool)
  if (callContext?.goal) {
    parts.push(`## Call Goal\n\n${callContext.goal}`);
  }
  if (callContext?.context) {
    parts.push(`## Call Context\n\n${callContext.context}`);
  }

  // --- Dynamic suffix ---

  // Memory injection — prefer structured records, fall back to legacy blob
  const hotTierPrompt = await memoryManager.getHotTierPrompt(
    agentConfig.id,
    config.memory.hotBudgetTokens,
  );
  if (hotTierPrompt) {
    parts.push(hotTierPrompt);
  } else {
    const memoryDir = `agents/${agentConfig.id}`;
    const memory = await memoryManager.read(`${memoryDir}/memory.md`);
    if (memory) {
      parts.push(`## Your Memory\n${memory}`);
    }
  }

  // Date/time last — changes every minute, preserves static prefix for caching
  const now = new Date();
  const pacific = now.toLocaleString("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  });
  parts.push(`**Current date/time**: ${pacific} (Pacific Time)`);

  return parts.join("\n\n---\n\n");
}
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3:** Commit

```bash
git add src/agents/prompt-builder.ts
git commit -m "feat(voice): shared prompt builder for voice calls (#105)"
```

---

### Task 3: OpenAI ↔ Claude Translation Layer

**Files:**
- Create: `src/channels/voice/openai-translator.ts`

- [ ] **Step 1:** Create `src/channels/voice/openai-translator.ts`

Stateless functions that translate between OpenAI and Claude API message formats.

```typescript
import type Anthropic from "@anthropic-ai/sdk";

// ── OpenAI types (inbound from Vapi) ───────────────────────────────────

export interface OpenAIMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string | null;
  tool_calls?: OpenAIToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface OpenAIToolCall {
  id: string;
  type: "function";
  function: {
    name: string;
    arguments: string;
  };
}

export interface OpenAIChatRequest {
  model?: string;
  messages: OpenAIMessage[];
  stream?: boolean;
  temperature?: number;
  max_tokens?: number;
  tools?: OpenAIToolDef[];
  metadata?: Record<string, unknown>;
  // Vapi includes call/assistant metadata in the request body
  call?: { id?: string; metadata?: Record<string, unknown> };
  assistant?: { id?: string; metadata?: Record<string, unknown> };
}

export interface OpenAIToolDef {
  type: "function";
  function: {
    name: string;
    description?: string;
    parameters?: Record<string, unknown>;
  };
}

// ── Translation: OpenAI messages → Claude messages ─────────────────────

/**
 * Translate OpenAI-format messages to Claude API format.
 * Returns { system, messages } for the Claude API call.
 */
export function openaiToClaude(
  openaiMessages: OpenAIMessage[],
  systemPrompt: string,
): {
  system: string;
  messages: Anthropic.MessageCreateParams["messages"];
} {
  const messages: Anthropic.MessageCreateParams["messages"] = [];

  for (const msg of openaiMessages) {
    if (msg.role === "system") {
      // System messages are merged into the system prompt (Vapi may send them)
      continue;
    }

    if (msg.role === "user") {
      messages.push({ role: "user", content: msg.content ?? "" });
    } else if (msg.role === "assistant") {
      if (msg.tool_calls && msg.tool_calls.length > 0) {
        // Assistant with tool calls → Claude tool_use blocks
        const content: Anthropic.ContentBlock[] = [];
        if (msg.content) {
          content.push({ type: "text", text: msg.content });
        }
        for (const tc of msg.tool_calls) {
          content.push({
            type: "tool_use",
            id: tc.id,
            name: tc.function.name,
            input: JSON.parse(tc.function.arguments || "{}"),
          });
        }
        messages.push({ role: "assistant", content } as any);
      } else {
        messages.push({ role: "assistant", content: msg.content ?? "" });
      }
    } else if (msg.role === "tool") {
      // Tool result → Claude tool_result block
      messages.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id ?? "",
            content: msg.content ?? "",
          },
        ],
      } as any);
    }
  }

  // Claude requires alternating user/assistant. If first message isn't user, prepend one.
  if (messages.length === 0 || messages[0].role !== "user") {
    messages.unshift({ role: "user", content: "[Call connected]" });
  }

  return { system: systemPrompt, messages };
}

// ── Translation: Claude tools → OpenAI tool definitions ────────────────

/**
 * Translate OpenAI tool definitions to Claude format.
 * Used when Vapi passes tool definitions in the request.
 */
export function openaiToolsToClaude(
  tools: OpenAIToolDef[] | undefined,
): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description ?? "",
    input_schema: (t.function.parameters ?? { type: "object", properties: {} }) as Anthropic.Tool.InputSchema,
  }));
}

// ── SSE streaming: Claude response → OpenAI format ─────────────────────

/**
 * Format a text chunk as an OpenAI SSE data line.
 */
export function formatSSETextChunk(id: string, text: string, model: string): string {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: { content: text },
        finish_reason: null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Format a tool call chunk as an OpenAI SSE data line.
 */
export function formatSSEToolCallChunk(
  id: string,
  toolCallId: string,
  functionName: string,
  args: string,
  model: string,
): string {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {
          tool_calls: [
            {
              index: 0,
              id: toolCallId,
              type: "function",
              function: { name: functionName, arguments: args },
            },
          ],
        },
        finish_reason: null,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\n`;
}

/**
 * Format the final SSE done chunk.
 */
export function formatSSEDone(id: string, model: string, finishReason: string = "stop"): string {
  const chunk = {
    id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        delta: {},
        finish_reason: finishReason,
      },
    ],
  };
  return `data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`;
}

/**
 * Format a non-streaming response (fallback).
 */
export function formatNonStreamingResponse(
  id: string,
  text: string,
  model: string,
): Record<string, unknown> {
  return {
    id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: text },
        finish_reason: "stop",
      },
    ],
  };
}
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3:** Commit

```bash
git add src/channels/voice/openai-translator.ts
git commit -m "feat(voice): OpenAI ↔ Claude translation layer (#105)"
```

---

### Task 4: Voice Adapter (HTTP Server)

**Files:**
- Create: `src/channels/voice/voice-adapter.ts`

- [ ] **Step 1:** Create `src/channels/voice/voice-adapter.ts`

HTTP server that Vapi calls. Handles `/v1/chat/completions` — receives OpenAI-format messages, translates to Claude, streams response back.

```typescript
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import Anthropic from "@anthropic-ai/sdk";
import { randomUUID } from "node:crypto";
import { createLogger } from "../../logging/logger.js";
import { buildVoiceSystemPrompt } from "../../agents/prompt-builder.js";
import {
  openaiToClaude,
  openaiToolsToClaude,
  formatSSETextChunk,
  formatSSEToolCallChunk,
  formatSSEDone,
  formatNonStreamingResponse,
  type OpenAIChatRequest,
} from "./openai-translator.js";
import type { AgentRegistry } from "../../agents/agent-registry.js";
import type { MemoryManager } from "../../memory/memory-manager.js";
import { config } from "../../config.js";

const log = createLogger("voice-adapter");

interface CallSession {
  callId: string;
  agentId: string;
  startedAt: Date;
}

const SESSION_TTL_MS = 2 * 60 * 60 * 1000; // 2 hours

export class VoiceAdapter {
  private httpServer: ReturnType<typeof createServer> | undefined;
  private anthropic: Anthropic;
  private sessions = new Map<string, CallSession>();
  private sweepTimer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private port: number,
    private serverSecret: string,
    private registry: AgentRegistry,
    private memoryManager: MemoryManager,
  ) {
    this.anthropic = new Anthropic();
  }

  async start(): Promise<void> {
    this.httpServer = createServer((req, res) => {
      this.handleRequest(req, res).catch((err) => {
        log.error("Voice request handler error", { error: String(err) });
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: "Internal server error" }));
        }
      });
    });

    await new Promise<void>((resolve) => {
      this.httpServer!.listen(this.port, () => resolve());
    });

    // Sweep stale sessions every 30 minutes
    this.sweepTimer = setInterval(() => this.sweepStaleSessions(), 30 * 60 * 1000);

    log.info("Voice adapter started", { port: this.port });
  }

  stop(): void {
    if (this.sweepTimer) clearInterval(this.sweepTimer);
    this.httpServer?.close();
    log.info("Voice adapter stopped");
  }

  private sweepStaleSessions(): void {
    const now = Date.now();
    let swept = 0;
    for (const [callId, session] of this.sessions) {
      if (now - session.startedAt.getTime() > SESSION_TTL_MS) {
        this.sessions.delete(callId);
        swept++;
      }
    }
    if (swept > 0) {
      log.info("Swept stale voice sessions", { count: swept });
    }
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    // Health check
    if (req.method === "GET" && req.url === "/health") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", activeCalls: this.sessions.size }));
      return;
    }

    // Only accept POST /v1/chat/completions
    if (req.method !== "POST" || req.url !== "/v1/chat/completions") {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Not found" }));
      return;
    }

    // Authenticate — fail-closed
    if (!this.serverSecret) {
      log.error("Voice endpoint called but VAPI_SERVER_SECRET not configured — rejecting");
      res.writeHead(403, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Server secret not configured" }));
      return;
    }

    const providedSecret =
      req.headers["x-vapi-secret"] as string ??
      req.headers["server-secret"] as string ??
      "";
    if (providedSecret !== this.serverSecret) {
      log.warn("Voice request rejected — invalid server secret");
      res.writeHead(401, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Unauthorized" }));
      return;
    }

    // Parse request body
    const body = await readBody(req);
    let request: OpenAIChatRequest;
    try {
      request = JSON.parse(body);
    } catch {
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Invalid JSON" }));
      return;
    }

    // Resolve agent ID from Vapi metadata
    const agentId = this.resolveAgentId(request);
    if (!agentId) {
      log.error("Could not resolve agent ID from Vapi request");
      res.writeHead(400, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: "Cannot determine agent identity" }));
      return;
    }

    const agentConfig = this.registry.get(agentId);
    if (!agentConfig) {
      log.error("Agent not found", { agentId });
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ error: `Agent not found: ${agentId}` }));
      return;
    }

    // Track session
    const callId = request.call?.id ?? randomUUID();
    if (!this.sessions.has(callId)) {
      this.sessions.set(callId, {
        callId,
        agentId,
        startedAt: new Date(),
      });
      log.info("Voice call session started", { callId, agentId });
    }

    // Build system prompt with call context
    const callMeta = request.call?.metadata as Record<string, string> | undefined;
    const systemPrompt = await buildVoiceSystemPrompt(
      agentConfig,
      this.memoryManager,
      {
        goal: callMeta?.goal,
        context: callMeta?.context,
      },
    );

    // Translate OpenAI → Claude
    const { system, messages } = openaiToClaude(request.messages, systemPrompt);
    const tools = openaiToolsToClaude(request.tools);

    const model = agentConfig.model;

    const completionId = `chatcmpl-${randomUUID()}`;

    if (request.stream === false) {
      // Non-streaming response
      const response = await this.anthropic.messages.create({
        model,
        max_tokens: 1024,
        system,
        messages,
        ...(tools ? { tools } : {}),
      });

      const textBlocks = response.content.filter((b) => b.type === "text");
      const text = textBlocks.map((b) => (b as any).text).join("");

      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify(formatNonStreamingResponse(completionId, text, model)));
      return;
    }

    // Streaming response (default — Vapi always sends stream: true)
    res.writeHead(200, {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      "Connection": "keep-alive",
    });

    try {
      const stream = this.anthropic.messages.stream({
        model,
        max_tokens: 1024,
        system,
        messages,
        ...(tools ? { tools } : {}),
      });

      // PoC: text streaming only. Tool call streaming (tool_use blocks → OpenAI
      // tool_calls format) is deferred to Phase 2 when live tool calling is wired.
      for await (const event of stream) {
        if (event.type === "content_block_delta") {
          const delta = event.delta as any;
          if (delta.type === "text_delta") {
            res.write(formatSSETextChunk(completionId, delta.text, model));
          }
        }
      }

      // Final done
      if (!res.writableEnded) {
        res.write(formatSSEDone(completionId, model));
      }
    } catch (err) {
      log.error("Claude streaming error", { error: String(err), callId, agentId });
      if (!res.writableEnded) {
        res.write(formatSSEDone(completionId, model, "error"));
      }
    }

    res.end();
  }

  /**
   * Resolve Hive agent ID from Vapi request metadata.
   *
   * Priority:
   * 1. assistant.metadata.hive_agent_id (set in Vapi dashboard)
   * 2. voice.assistants mapping in hive.yaml (Vapi assistant ID → Hive agent ID)
   * 3. call.metadata.hive_agent_id (set when initiating call via MCP)
   */
  private resolveAgentId(request: OpenAIChatRequest): string | undefined {
    // From assistant metadata
    const assistantMeta = request.assistant?.metadata as Record<string, string> | undefined;
    if (assistantMeta?.hive_agent_id) return assistantMeta.hive_agent_id;

    // From config mapping
    const assistantId = request.assistant?.id;
    if (assistantId && config.voice.assistants[assistantId]) {
      return config.voice.assistants[assistantId];
    }

    // From call metadata
    const callMeta = request.call?.metadata as Record<string, string> | undefined;
    if (callMeta?.hive_agent_id) return callMeta.hive_agent_id;

    return undefined;
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf-8")));
    req.on("error", reject);
  });
}
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3:** Commit

```bash
git add src/channels/voice/voice-adapter.ts
git commit -m "feat(voice): voice adapter HTTP server for Vapi (#105)"
```

---

### Task 5: Voice MCP Server

**Files:**
- Create: `src/voice/voice-mcp-server.ts`

- [ ] **Step 1:** Create `src/voice/voice-mcp-server.ts`

Agent-facing MCP server — lets agents initiate and monitor calls via Vapi API.

```typescript
#!/usr/bin/env node

/**
 * Voice MCP Server — lets agents make and monitor phone calls via Vapi.
 *
 * Env vars (set by agent-runner):
 *   VAPI_API_KEY       — Vapi API key for REST calls
 *   VAPI_PHONE_NUMBER_ID — default outbound phone number ID
 *   VAPI_ASSISTANT_ID  — Vapi assistant ID to use for calls
 *   AGENT_ID           — the calling agent's Hive ID
 *   AGENT_NAME         — the calling agent's display name
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const VAPI_API_KEY = process.env.VAPI_API_KEY ?? "";
const VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID ?? "";
const VAPI_ASSISTANT_ID = process.env.VAPI_ASSISTANT_ID ?? "";
const AGENT_ID = process.env.AGENT_ID ?? "";
const AGENT_NAME = process.env.AGENT_NAME ?? "";

if (!VAPI_API_KEY) {
  process.stderr.write("voice-mcp-server: VAPI_API_KEY is required\n");
  process.exit(1);
}

const VAPI_BASE = "https://api.vapi.ai";

async function vapiRequest(method: string, path: string, body?: unknown): Promise<unknown> {
  const res = await fetch(`${VAPI_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${VAPI_API_KEY}`,
      "Content-Type": "application/json",
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Vapi API error ${res.status}: ${text}`);
  }

  return res.json();
}

const server = new McpServer({ name: "voice", version: "1.0.0" });

// ── Tool: voice_call ───────────────────────────────────────────────────

server.registerTool(
  "voice_call",
  {
    title: "Make Phone Call",
    description:
      "Initiate an outbound phone call via Vapi. You (the agent) will be the voice on the call — " +
      "Vapi handles speech-to-text and text-to-speech while you provide the conversation. " +
      "Provide a clear goal describing what you want to accomplish on the call.",
    inputSchema: {
      to: z.string().describe("Recipient phone number in E.164 format (e.g., +14155551234)"),
      goal: z.string().describe("What you want to accomplish on this call — this is injected into your system prompt during the call"),
      context: z.string().optional().describe("Additional context for the call (order details, customer history, etc.)"),
    },
  },
  async ({ to, goal, context }) => {
    if (!VAPI_ASSISTANT_ID) {
      return {
        content: [{ type: "text", text: "Error: No Vapi assistant configured. Set VAPI_ASSISTANT_ID." }],
        isError: true,
      };
    }

    if (!VAPI_PHONE_NUMBER_ID) {
      return {
        content: [{ type: "text", text: "Error: No outbound phone number configured. Set VAPI_PHONE_NUMBER_ID." }],
        isError: true,
      };
    }

    try {
      const result = await vapiRequest("POST", "/call", {
        assistantId: VAPI_ASSISTANT_ID,
        phoneNumberId: VAPI_PHONE_NUMBER_ID,
        customer: { number: to },
        metadata: {
          hive_agent_id: AGENT_ID,
          agent_name: AGENT_NAME,
          goal,
          context: context ?? "",
        },
      }) as any;

      return {
        content: [
          {
            type: "text",
            text: [
              `Call initiated successfully.`,
              `Call ID: ${result.id}`,
              `Status: ${result.status}`,
              `To: ${to}`,
              ``,
              `The call is now in progress. Use voice_call_status to check on it later.`,
            ].join("\n"),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to initiate call: ${String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Tool: voice_call_status ────────────────────────────────────────────

server.registerTool(
  "voice_call_status",
  {
    title: "Check Call Status",
    description:
      "Check the status of a voice call. Returns status, duration, and transcript (if the call has ended).",
    inputSchema: {
      call_id: z.string().describe("The call ID returned from voice_call"),
    },
  },
  async ({ call_id }) => {
    try {
      const call = await vapiRequest("GET", `/call/${call_id}`) as any;

      const lines: string[] = [
        `Call ID: ${call.id}`,
        `Status: ${call.status}`,
        `Type: ${call.type}`,
      ];

      if (call.startedAt) lines.push(`Started: ${call.startedAt}`);
      if (call.endedAt) lines.push(`Ended: ${call.endedAt}`);
      if (call.cost) lines.push(`Cost: $${call.cost.toFixed(4)}`);

      if (call.transcript) {
        lines.push("", "--- Transcript ---", call.transcript);
      }

      if (call.summary) {
        lines.push("", "--- Summary ---", call.summary);
      }

      if (call.analysis) {
        lines.push("", "--- Analysis ---", JSON.stringify(call.analysis, null, 2));
      }

      return {
        content: [{ type: "text", text: lines.join("\n") }],
      };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to get call status: ${String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Tool: voice_list_calls ─────────────────────────────────────────────

server.registerTool(
  "voice_list_calls",
  {
    title: "List Recent Calls",
    description: "List recent voice calls.",
    inputSchema: {
      limit: z.number().optional().describe("Number of calls to return (default 10)"),
    },
  },
  async ({ limit }) => {
    try {
      const calls = await vapiRequest("GET", `/call?limit=${limit ?? 10}`) as any[];

      if (!calls || calls.length === 0) {
        return { content: [{ type: "text", text: "No recent calls found." }] };
      }

      const lines = calls.map((c: any) => {
        const to = c.customer?.number ?? "unknown";
        const status = c.status ?? "unknown";
        const duration = c.duration ? `${Math.round(c.duration / 60)}m` : "n/a";
        return `${c.id} — ${to} — ${status} — ${duration}`;
      });

      return { content: [{ type: "text", text: lines.join("\n") }] };
    } catch (err) {
      return {
        content: [{ type: "text", text: `Failed to list calls: ${String(err)}` }],
        isError: true,
      };
    }
  },
);

// ── Connect ─────────────────────────────────────────────────────────────

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2:** Verify

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 3:** Commit

```bash
git add src/voice/voice-mcp-server.ts
git commit -m "feat(voice): voice MCP server — call initiation and monitoring (#105)"
```

---

### Task 6: Agent Runner Wiring

**Files:**
- Modify: `src/agents/agent-runner.ts:229-242` (after Quo MCP server block)

- [ ] **Step 1:** Add voice MCP server to `buildAllServerConfigs()`

After the Quo MCP server block (line 242), add:

```typescript
    // Voice MCP server — outbound phone calls via Vapi
    if (config.voice.apiKey) {
      // Resolve the Vapi assistant ID for this agent (reverse lookup from config.voice.assistants)
      const vapiAssistantId = Object.entries(config.voice.assistants)
        .find(([_, hiveId]) => hiveId === this.agentConfig.id)?.[0] ?? "";

      servers["voice"] = {
        type: "stdio",
        command: "node",
        args: [resolve("dist/voice/voice-mcp-server.js")],
        env: {
          VAPI_API_KEY: config.voice.apiKey,
          VAPI_PHONE_NUMBER_ID: config.voice.phoneNumberId,
          VAPI_ASSISTANT_ID: vapiAssistantId,
          AGENT_ID: this.agentConfig.id,
          AGENT_NAME: this.agentConfig.name,
        },
      };
    }
```

- [ ] **Step 2:** Add voice to server catalog in `src/tools/server-catalog.ts`

Add an entry for the voice server:

```typescript
  voice: {
    description: "Make outbound phone calls via Vapi",
    usage: "Calling customers, scheduling appointments, following up by phone",
  },
```

- [ ] **Step 3:** Verify

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4:** Commit

```bash
git add src/agents/agent-runner.ts src/tools/server-catalog.ts
git commit -m "feat(voice): wire voice MCP server into agent-runner (#105)"
```

---

### Task 7: Startup & Shutdown Wiring

**Files:**
- Modify: `src/index.ts:351-378` (after WS adapter, before scheduler)
- Modify: `src/index.ts:418-440` (shutdown handler)

- [ ] **Step 1:** Add voice adapter startup in `src/index.ts`

After the WS adapter block (after line 351), add:

```typescript
  // Voice adapter — Vapi phone integration (custom LLM endpoint)
  let voiceAdapter: import("./channels/voice/voice-adapter.js").VoiceAdapter | undefined;
  if (config.voice.enabled && config.voice.serverSecret) {
    const { VoiceAdapter } = await import("./channels/voice/voice-adapter.js");

    voiceAdapter = new VoiceAdapter(
      config.voice.port,
      config.voice.serverSecret,
      registry,
      memoryManager,
    );
    await voiceAdapter.start();
    log.info("Voice adapter started", { port: config.voice.port });
  }
```

- [ ] **Step 2:** Add voice adapter to shutdown handler

In the shutdown function (around line 425, after `if (wsAdapter) await wsAdapter.stop();`), add:

```typescript
    voiceAdapter?.stop();
```

- [ ] **Step 3:** Verify

Run: `npx tsc --noEmit`
Expected: No errors

- [ ] **Step 4:** Build and smoke test

Run: `npm run build`
Expected: Clean build with no errors

- [ ] **Step 5:** Commit

```bash
git add src/index.ts
git commit -m "feat(voice): wire voice adapter into startup/shutdown (#105)"
```

---

### Task 8: Manual Setup & End-to-End Test

No code changes — this is configuration and testing.

- [ ] **Step 1:** Add secrets to `.env` (or `.env-personal`)

```
VAPI_API_KEY=<your-key>
VAPI_SERVER_SECRET=<generate-a-random-secret>
```

- [ ] **Step 2:** Add voice config to `hive.yaml` (or `hive-personal.yaml`)

```yaml
voice:
  provider: vapi
  publicUrl: "https://voice.dodihome.com"
  phoneNumberId: "<vapi-phone-number-id>"
  assistants:
    "<vapi-assistant-id>": chief-of-staff
```

- [ ] **Step 3:** Set up Vapi dashboard

1. Add Anthropic API key in Provider Keys (NOT used for LLM — Vapi uses it for fallback only; our custom LLM endpoint handles Claude calls)
2. Create assistant:
   - Custom LLM URL: `https://voice.dodihome.com/v1/chat/completions`
   - Server secret: same value as `VAPI_SERVER_SECRET`
   - Voice: pick one (ElevenLabs recommended)
   - Set `metadata.hive_agent_id` to `chief-of-staff`
3. Provision or import a phone number
4. Note the assistant ID and phone number ID for hive.yaml

- [ ] **Step 4:** Add Cloudflare Tunnel route

Add `voice.dodihome.com → localhost:3105` to the Cloudflare Tunnel config.

- [ ] **Step 5:** Add `voice` to agent's coreServers

Via admin API or MongoDB, add `"voice"` to the chief-of-staff agent's `coreServers` array.

- [ ] **Step 6:** Build, restart, test

```bash
npm run build
# Restart Hive (dev mode or launchctl)
```

Test: Ask the chief-of-staff agent (via Slack or WS) to call your phone number. Verify:
- Phone rings
- Voice answers as the agent
- Two-way conversation works
- Agent can retrieve transcript via `voice_call_status`

- [ ] **Step 7:** Commit config changes (if any tracked files changed)

```bash
git add -A
git commit -m "feat(voice): end-to-end Vapi voice pipeline PoC (#105)"
```
