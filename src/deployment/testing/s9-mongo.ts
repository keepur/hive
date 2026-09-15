import { spawn, type ChildProcess } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";

const MONGOD = "/opt/homebrew/bin/mongod";

export interface DisposableMongo {
  uri: string;
  port: number;
  dbpath: string;
  stop(): Promise<void>;
}

function waitPort(port: number, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  return new Promise((resolvePromise, rejectPromise) => {
    const attempt = () => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => {
        socket.end();
        resolvePromise();
      });
      socket.once("error", () => {
        socket.destroy();
        if (Date.now() - start > timeoutMs) rejectPromise(new Error(`mongod did not listen on ${port}`));
        else setTimeout(attempt, 50);
      });
    };
    attempt();
  });
}

export async function startDisposableMongo(port: number): Promise<DisposableMongo> {
  const root = mkdtempSync(join(tmpdir(), "hive-s9-mongo-"));
  const dbpath = join(root, "db");
  mkdirSync(dbpath, { mode: 0o755 });
  const logpath = join(root, "mongod.log");
  writeFileSync(logpath, "");
  const child: ChildProcess = spawn(
    MONGOD,
    ["--bind_ip", "127.0.0.1", "--port", String(port), "--dbpath", dbpath, "--logpath", logpath],
    { stdio: "ignore" },
  );
  if (!child.pid) throw new Error("mongod failed to spawn");
  try {
    await waitPort(port);
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
  return {
    uri: `mongodb://127.0.0.1:${port}`,
    port,
    dbpath,
    async stop() {
      child.kill("SIGTERM");
      await new Promise<void>((resolvePromise) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolvePromise();
        }, 5_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolvePromise();
        });
      });
    },
  };
}
