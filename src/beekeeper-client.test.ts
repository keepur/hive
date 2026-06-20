import { describe, it, expect, vi, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { AddressInfo } from "node:net";
import { startBeekeeperRegistration } from "./beekeeper-client.js";
import { createKeepAliveAgent } from "./http/loopback-dispatcher.js";

vi.mock("./logging/logger.js", () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

async function listen(server: Server): Promise<number> {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function waitFor(predicate: () => boolean, timeoutMs = 2000): Promise<void> {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = () => {
      if (predicate()) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error("waitFor timeout"));
      setTimeout(tick, 10);
    };
    tick();
  });
}

describe("startBeekeeperRegistration", () => {
  let stopHandle: { stop: () => void } | undefined;
  let server: Server | undefined;

  afterEach(async () => {
    stopHandle?.stop();
    stopHandle = undefined;
    if (server) {
      await new Promise<void>((resolve) => server!.close(() => resolve()));
      server = undefined;
    }
  });

  it("POSTs registration payload immediately and re-POSTs on interval", async () => {
    const bodies: unknown[] = [];
    server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/internal/register-capability") {
        let raw = "";
        req.on("data", (chunk: Buffer) => {
          raw += chunk.toString();
        });
        req.on("end", () => {
          bodies.push(JSON.parse(raw));
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const port = await listen(server);

    stopHandle = startBeekeeperRegistration({
      beekeeperPort: port,
      wsPort: 4321,
      intervalMs: 20,
    });

    await waitFor(() => bodies.length >= 2);

    expect(bodies.length).toBeGreaterThanOrEqual(2);
    expect(bodies[0]).toEqual({
      name: "hive",
      localWsUrl: "ws://127.0.0.1:4321",
      healthUrl: "http://127.0.0.1:4321/health",
    });
    // Payload is stable across re-POSTs.
    expect(bodies[1]).toEqual(bodies[0]);
  });

  it("does not crash when beekeeper is unreachable", async () => {
    // Use a port that is almost certainly not listening.
    stopHandle = startBeekeeperRegistration({
      beekeeperPort: 1,
      wsPort: 4321,
      intervalMs: 20,
    });

    // Give the loop time to fire several times and fail.
    await new Promise((resolve) => setTimeout(resolve, 100));

    // If we got here without an unhandled rejection, we're good.
    expect(typeof stopHandle.stop).toBe("function");
  });

  it("reuses a single TCP connection across registration ticks", async () => {
    let connections = 0;
    const agent = createKeepAliveAgent();
    server = createServer((req, res) => {
      if (req.method === "POST" && req.url === "/internal/register-capability") {
        req.on("data", () => {});
        req.on("end", () => {
          res.writeHead(200, { "content-type": "application/json" });
          res.end("{}");
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    server.on("connection", () => {
      connections += 1;
    });
    const port = await listen(server);

    stopHandle = startBeekeeperRegistration({
      beekeeperPort: port,
      wsPort: 4321,
      intervalMs: 20,
      dispatcher: agent,
    });

    // Wait until several ticks have fired (well past 3 × 20ms).
    await new Promise((resolve) => setTimeout(resolve, 150));
    stopHandle.stop();
    stopHandle = undefined;
    await agent.close();

    // All ticks rode one pooled connection, not one socket per tick.
    expect(connections).toBe(1);
  });
});
