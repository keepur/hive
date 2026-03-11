import { describe, it, expect, vi, beforeAll, afterAll } from "vitest";

vi.mock("../logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { MeetingMonitor } from "./meeting-monitor.js";

// ── Webhook with secret configured ─────────────────────────────────
describe("webhook with secret configured", () => {
  const PORT = 39200;
  const SECRET = "test-secret-abc";
  const BASE = `http://127.0.0.1:${PORT}`;
  let monitor: MeetingMonitor;

  beforeAll(async () => {
    monitor = new MeetingMonitor(PORT, SECRET, () => {});
    await monitor.start();
  });

  afterAll(() => {
    monitor.stop();
  });

  it("returns 404 for POST /webhook/transcript (no secret in path)", async () => {
    const res = await fetch(`${BASE}/webhook/transcript`, { method: "POST" });
    expect(res.status).toBe(404);
  });

  it("returns 404 for POST /webhook/transcript/wrong-secret", async () => {
    const res = await fetch(`${BASE}/webhook/transcript/wrong-secret`, {
      method: "POST",
    });
    expect(res.status).toBe(404);
  });

  it("returns 200 for POST /webhook/transcript/<correct-secret>", async () => {
    const res = await fetch(`${BASE}/webhook/transcript/${SECRET}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        event: "transcript.data",
        data: {
          bot: { id: "bot-123" },
          data: {
            participant: { id: 1, name: "Alice" },
            words: [{ text: "hello" }],
          },
        },
      }),
    });
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toEqual({ ok: true });
  });

  it("returns 404 for unrelated paths", async () => {
    const res = await fetch(`${BASE}/webhook/other`, { method: "POST" });
    expect(res.status).toBe(404);
  });
});

// ── Webhook with NO secret configured ──────────────────────────────
describe("webhook with NO secret configured", () => {
  const PORT = 39201;
  const BASE = `http://127.0.0.1:${PORT}`;
  let monitor: MeetingMonitor;

  beforeAll(async () => {
    monitor = new MeetingMonitor(PORT, "", () => {});
    await monitor.start();
  });

  afterAll(() => {
    monitor.stop();
  });

  it("returns 403 for POST /webhook/transcript (no secret configured)", async () => {
    const res = await fetch(`${BASE}/webhook/transcript`, { method: "POST" });
    expect(res.status).toBe(403);
  });

  it("returns 403 for POST /webhook/transcript/anything", async () => {
    const res = await fetch(`${BASE}/webhook/transcript/anything`, {
      method: "POST",
    });
    expect(res.status).toBe(403);
  });
});
