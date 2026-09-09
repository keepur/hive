import { JobRequest } from "@livekit/agents";
import { afterEach, beforeAll, expect, it } from "vitest";
import { fork, type ChildProcess } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { AdmissionLedger, type SupervisorRef } from "./admission.js";

type IpcMessage = { case: string; value?: unknown };
type ProtoConstructor = new (data?: Record<string, unknown>) => object;

const SUPERVISOR: SupervisorRef = { pid: 700, bootId: "sdk-proof-boot" };
const TEST_TIMEOUT_MS = 15_000;
const projectRoot = fileURLToPath(new URL("../..", import.meta.url));
const compiledFixture = join(projectRoot, "dist/voice-worker/fixtures/sdk-agent.js");
const agentsEntry = createRequire(import.meta.url).resolve("@livekit/agents");
const agentsRoot = dirname(dirname(agentsEntry));
const sdkChildMain = join(agentsRoot, "dist/ipc/job_proc_lazy_main.js");

let JobProto: ProtoConstructor;
let RoomProto: ProtoConstructor;
const children = new Set<ChildProcess>();
const scratchRoots = new Set<string>();

beforeAll(async () => {
  const protocolEntry = createRequire(agentsEntry).resolve("@livekit/protocol");
  const protocol = (await import(pathToFileURL(protocolEntry).href)) as {
    Job: ProtoConstructor;
    Room: ProtoConstructor;
  };
  JobProto = protocol.Job;
  RoomProto = protocol.Room;
});

afterEach(async () => {
  await Promise.all(
    [...children].map(async (child) => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGKILL");
        await new Promise<void>((resolve) => child.once("exit", () => resolve()));
      }
      children.delete(child);
    }),
  );
  for (const root of scratchRoots) rmSync(root, { recursive: true, force: true });
  scratchRoots.clear();
});

function isIpcMessage(message: unknown): message is IpcMessage {
  return typeof message === "object" && message !== null && "case" in message && typeof message.case === "string";
}

class ChildHarness {
  readonly messages: IpcMessage[] = [];
  readonly stderr: string[] = [];
  readonly child: ChildProcess;

  constructor(mode: string) {
    const scratch = mkdtempSync(join(tmpdir(), "hive-sdk-lifecycle-"));
    scratchRoots.add(scratch);
    this.child = fork(sdkChildMain, [compiledFixture], {
      cwd: scratch,
      env: {
        HOME: scratch,
        TMPDIR: scratch,
        PATH: process.env.PATH,
        NODE_ENV: "test",
        HIVE_SDK_FIXTURE_MODE: mode,
      },
      stdio: ["ignore", "pipe", "pipe", "ipc"],
    });
    children.add(this.child);
    this.child.on("message", (message) => {
      if (isIpcMessage(message)) this.messages.push(message);
    });
    this.child.stderr?.on("data", (chunk: Buffer | string) => this.stderr.push(String(chunk)));
  }

  send(message: IpcMessage): void {
    this.child.send?.(message);
  }

  async waitFor(caseName: string): Promise<IpcMessage> {
    const existing = this.messages.find((message) => message.case === caseName);
    if (existing) return existing;
    return new Promise<IpcMessage>((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(
          new Error(
            `timed out waiting for ${caseName}; messages=${this.messages.map((m) => m.case).join(",")}; stderr=${this.stderr.join("")}`,
          ),
        );
      }, TEST_TIMEOUT_MS);
      const onMessage = (message: unknown) => {
        if (!isIpcMessage(message) || message.case !== caseName) return;
        cleanup();
        resolve(message);
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        reject(
          new Error(
            `child exited before ${caseName}: code=${String(code)} signal=${String(signal)} stderr=${this.stderr.join("")}`,
          ),
        );
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.child.off("message", onMessage);
        this.child.off("exit", onExit);
      };
      this.child.on("message", onMessage);
      this.child.on("exit", onExit);
    });
  }

  async waitForExit(): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) {
      return { code: this.child.exitCode, signal: this.child.signalCode };
    }
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        cleanup();
        reject(new Error(`timed out waiting for child exit; stderr=${this.stderr.join("")}`));
      }, TEST_TIMEOUT_MS);
      const onExit = (code: number | null, signal: NodeJS.Signals | null) => {
        cleanup();
        resolve({ code, signal });
      };
      const cleanup = () => {
        clearTimeout(timeout);
        this.child.off("exit", onExit);
      };
      this.child.on("exit", onExit);
    });
  }
}

function runningJob() {
  return {
    job: new JobProto({
      id: "job-a",
      room: new RoomProto({ name: "fixture" }),
      metadata: "{}",
    }),
    acceptArguments: { identity: "agent-job-a", name: "", metadata: "" },
    url: "ws://127.0.0.1:1",
    token: "fixture-token",
    workerId: "fixture-worker",
  };
}

async function reservedLedger(): Promise<AdmissionLedger> {
  const ledger = new AdmissionLedger(SUPERVISOR, () => {});
  await ledger.request(
    new JobRequest(
      { id: "job-a" } as JobRequest["job"],
      async () => {
        throw new Error("unexpected rejection");
      },
      async () => {},
    ),
  );
  return ledger;
}

async function initializeAndStart(harness: ChildHarness): Promise<void> {
  harness.send({
    case: "initializeRequest",
    value: { loggerOptions: { level: "error", pretty: false } },
  });
  await harness.waitFor("initializeResponse");
  harness.send({ case: "startJobRequest", value: { runningJob: runningJob() } });
}

it(
  "holds the accepted ledger through parent-controlled Hive cleanup before SDK done and exit",
  async () => {
    const ledger = await reservedLedger();
    const harness = new ChildHarness("normal");
    await initializeAndStart(harness);

    await harness.waitFor("hive-entry");
    ledger.entered(SUPERVISOR, "job-a", harness.child.pid!);
    harness.send({ case: "shutdownRequest", value: {} });

    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(harness.messages.map((message) => message.case)).not.toContain("done");
    expect(ledger.snapshot().unresolved).toMatchObject([
      { jobId: "job-a", phase: "entered-awaiting-completion", childPid: harness.child.pid },
    ]);

    harness.send({ case: "release-cleanup", value: {} });
    await harness.waitFor("cleanup-finished");
    await harness.waitFor("hive-completion");
    ledger.completed(SUPERVISOR, "job-a", harness.child.pid!);
    await harness.waitFor("done");
    const exit = await harness.waitForExit();

    expect(exit).toEqual({ code: 0, signal: null });
    expect(ledger.snapshot().unresolved).toEqual([]);
    const cases = harness.messages.map((message) => message.case);
    expect(cases.indexOf("hive-entry")).toBeLessThan(cases.indexOf("cleanup-finished"));
    expect(cases.indexOf("cleanup-finished")).toBeLessThan(cases.indexOf("hive-completion"));
    expect(cases.indexOf("hive-completion")).toBeLessThan(cases.indexOf("done"));
  },
  TEST_TIMEOUT_MS,
);

it(
  "reports completion after work throws before session setup",
  async () => {
    const ledger = await reservedLedger();
    const harness = new ChildHarness("throw-before-session");
    await initializeAndStart(harness);

    await harness.waitFor("hive-entry");
    ledger.entered(SUPERVISOR, "job-a", harness.child.pid!);
    await harness.waitFor("hive-completion");
    ledger.completed(SUPERVISOR, "job-a", harness.child.pid!);
    await harness.waitFor("done");
    const exit = await harness.waitForExit();

    expect(exit).toEqual({ code: 0, signal: null });
    expect(ledger.snapshot().unresolved).toEqual([]);
  },
  TEST_TIMEOUT_MS,
);

it(
  "retains an accepted diagnostic when the SDK process exits before Hive entry",
  async () => {
    const ledger = await reservedLedger();
    const harness = new ChildHarness("exit-before-entry");
    await initializeAndStart(harness);

    const exit = await harness.waitForExit();

    expect(exit).toEqual({ code: 23, signal: null });
    expect(harness.messages.map((message) => message.case)).not.toContain("hive-entry");
    expect(ledger.snapshot().unresolved).toMatchObject([{ jobId: "job-a", phase: "accepted-awaiting-entry" }]);
  },
  TEST_TIMEOUT_MS,
);

it(
  "retains an entered diagnostic when completion persistence is suppressed even after SDK exit",
  async () => {
    const ledger = await reservedLedger();
    const harness = new ChildHarness("suppress-completion");
    await initializeAndStart(harness);

    await harness.waitFor("hive-entry");
    ledger.entered(SUPERVISOR, "job-a", harness.child.pid!);
    harness.send({ case: "shutdownRequest", value: {} });
    harness.send({ case: "release-cleanup", value: {} });
    await harness.waitFor("cleanup-finished");
    await harness.waitFor("done");
    const exit = await harness.waitForExit();

    expect(exit).toEqual({ code: 0, signal: null });
    expect(harness.messages.map((message) => message.case)).not.toContain("hive-completion");
    expect(ledger.snapshot().unresolved).toMatchObject([
      { jobId: "job-a", phase: "entered-awaiting-completion", childPid: harness.child.pid },
    ]);
  },
  TEST_TIMEOUT_MS,
);
