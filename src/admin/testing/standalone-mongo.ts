import { spawn, type ChildProcess } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MongoClient } from "mongodb";

async function freePort(): Promise<number> {
  const server = createServer();
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) =>
        error ? reject(error) : port && port !== 27017 ? resolve(port) : reject(new Error("No isolated test port")),
      );
    });
  });
}

async function stop(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null || child.pid === undefined) return;
  await new Promise<void>((resolve) => {
    const timer = setTimeout(() => child.kill("SIGKILL"), 5_000);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill("SIGTERM");
  });
}

export async function startStandaloneMongo() {
  const port = await freePort();
  const directory = await mkdtemp(join(tmpdir(), "hive-kpr459-mongo-"));
  let child: ChildProcess;
  try {
    child = spawn(
      process.env.MONGOD_BINARY || "mongod",
      [
        "--dbpath",
        directory,
        "--bind_ip",
        "127.0.0.1",
        "--port",
        String(port),
        "--storageEngine",
        "wiredTiger",
        "--nounixsocket",
        "--setParameter",
        "diagnosticDataCollectionEnabled=false",
      ],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
  } catch (error) {
    await rm(directory, { recursive: true, force: true });
    throw error;
  }

  let client: MongoClient | undefined;
  const close = async () => {
    try {
      await client?.close();
    } finally {
      try {
        await stop(child);
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    }
  };

  try {
    await new Promise<void>((resolve, reject) => {
      let logs = "";
      let settled = false;
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.removeListener("error", onError);
        child.removeListener("exit", onExit);
        child.stdout?.removeListener("data", onData);
        child.stderr?.removeListener("data", onData);
        if (error) reject(error);
        else resolve();
      };
      const timer = setTimeout(() => finish(new Error("Owned standalone mongod did not become ready")), 20_000);
      const onError = () =>
        finish(new Error("Unable to spawn mongod; install a local MongoDB server or set MONGOD_BINARY"));
      const onExit = () => finish(new Error("Owned mongod exited before readiness"));
      const onData = (chunk: Buffer) => {
        logs = (logs + chunk.toString()).slice(-64 * 1024);
        if (logs.includes("Waiting for connections")) finish();
      };
      child.once("error", onError);
      child.once("exit", onExit);
      child.stdout?.on("data", onData);
      child.stderr?.on("data", onData);
    });
    child.stdout?.resume();
    child.stderr?.resume();
    client = new MongoClient(`mongodb://127.0.0.1:${port}/?directConnection=true&retryWrites=false`, {
      serverSelectionTimeoutMS: 3_000,
      monitorCommands: true,
    });
    await client.connect();
    const db = client.db(`hive_kpr459_test_${randomUUID().replaceAll("-", "")}`);
    const hello = await db.admin().command({ hello: 1 });
    const status = await db.admin().command({ serverStatus: 1 });
    if (hello.setName || status.storageEngine?.name !== "wiredTiger") {
      throw new Error("Integration requires standalone WiredTiger");
    }
    return { db, client, close };
  } catch (error) {
    await close();
    throw error;
  }
}
