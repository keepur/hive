import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { Agent } from "undici";
import {
  KEEPALIVE_TIMEOUT_MS,
  createKeepAliveAgent,
  installKeepAliveDispatcher,
} from "./loopback-dispatcher.js";
import { DEFAULT_REGISTRATION_INTERVAL_MS } from "../beekeeper-client.js";

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

describe("loopback-dispatcher", () => {
  let server: Server | undefined;
  let agent: Agent | undefined;

  afterEach(async () => {
    if (agent) {
      await agent.close();
      agent = undefined;
    }
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("keep-alive idle timeout exceeds the registration poll interval", () => {
    // The core invariant of the fix (KPR-252).
    expect(KEEPALIVE_TIMEOUT_MS).toBeGreaterThan(DEFAULT_REGISTRATION_INTERVAL_MS);
  });

  it("installKeepAliveDispatcher is idempotent", () => {
    expect(() => {
      installKeepAliveDispatcher();
      installKeepAliveDispatcher();
    }).not.toThrow();
  });

  it("reuses a single TCP connection across sequential requests", async () => {
    let connections = 0;
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    server.on("connection", () => {
      connections += 1;
    });
    const port = await listen(server);
    agent = createKeepAliveAgent();

    for (let i = 0; i < 5; i++) {
      // `dispatcher` is a documented field on RequestInit (via @types/node →
      // undici-types) in this repo — no cast needed.
      const res = await fetch(`http://127.0.0.1:${port}/`, { dispatcher: agent });
      await res.text();
      // Yield one macrotask tick so undici recycles the just-used socket back
      // into the free pool before the next dispatch. Without this, back-to-back
      // dispatches race the socket's release and undici opens a transient 2nd
      // connection (then pools it) — a warm-up artifact of the pool, not a
      // reuse failure. One tick lets the steady-state (single pooled socket)
      // assertion hold deterministically.
      await new Promise<void>((resolve) => setImmediate(resolve));
    }

    expect(connections).toBe(1);
  });

  it("negative control: a fresh dispatcher per request opens one socket each", async () => {
    // Proves the connection counter detects churn: without a shared pool, each
    // request rides its own Agent (its own pool) and opens a new TCP connection.
    let connections = 0;
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "application/json" });
      res.end("{}");
    });
    server.on("connection", () => {
      connections += 1;
    });
    const port = await listen(server);

    for (let i = 0; i < 5; i++) {
      const perCall = createKeepAliveAgent();
      const res = await fetch(`http://127.0.0.1:${port}/`, { dispatcher: perCall });
      await res.text();
      await perCall.close();
    }

    expect(connections).toBe(5);
  });
});
