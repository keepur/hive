import { randomUUID } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";
import { parseBootIdentity } from "./health.js";
import { buildServiceEnvironment, servicePortKeys, ServiceController } from "./services.js";
import { requestMaintenance, type MaintenanceReply } from "../voice-worker/maintenance-ipc.js";

export type RuntimeProbeMode = "config" | "bridge" | "worker" | "outbound";

export interface BridgeProbeResult {
  authenticated: boolean;
  missingDenied: boolean;
  wrongDenied: boolean;
  correctStatus: number | null;
  missingStatus: number | null;
  wrongStatus: number | null;
  classification: string;
}

type FetchLike = typeof fetch;

async function bridgeRequest(url: string, token: string | null, fetchImpl: FetchLike): Promise<Response> {
  return fetchImpl(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(token === null ? {} : { Authorization: `Bearer ${token}` }),
    },
    body: "{}",
    signal: AbortSignal.timeout(2_000),
  });
}

async function exactMissingAgent(response: Response): Promise<boolean> {
  if (response.status !== 400) return false;
  try {
    const body = (await response.json()) as { error?: unknown };
    return body.error === "call.metadata.hive_agent_id required" && Object.keys(body).length === 1;
  } catch {
    return false;
  }
}

export async function probeBridge(
  url: string,
  token: string,
  fetchImpl: FetchLike = fetch,
  randomToken: () => string = randomUUID,
): Promise<BridgeProbeResult> {
  if (!token) throw new Error("bridge probe missing configured token");
  const wrong = randomToken();
  if (!wrong || wrong === token) throw new Error("bridge probe could not generate independent wrong token");
  try {
    const [correct, missing, incorrect] = await Promise.all([
      bridgeRequest(url, token, fetchImpl),
      bridgeRequest(url, null, fetchImpl),
      bridgeRequest(url, wrong, fetchImpl),
    ]);
    const authenticated = await exactMissingAgent(correct);
    const missingDenied = missing.status === 401 || missing.status === 403;
    const wrongDenied = incorrect.status === 401 || incorrect.status === 403;
    return {
      authenticated,
      missingDenied,
      wrongDenied,
      correctStatus: correct.status,
      missingStatus: missing.status,
      wrongStatus: incorrect.status,
      classification:
        authenticated && missingDenied && wrongDenied ? "bridge-authenticated" : "bridge-authentication-failed",
    };
  } catch {
    return {
      authenticated: false,
      missingDenied: false,
      wrongDenied: false,
      correctStatus: null,
      missingStatus: null,
      wrongStatus: null,
      classification: "bridge-unreachable",
    };
  }
}

function selectedEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const selected: Record<string, string> = {};
  for (const [key, value] of Object.entries(environment)) {
    if (value !== undefined) selected[key] = value;
  }
  return selected;
}

export function assertRuntimeProbeEnvironment(environment: NodeJS.ProcessEnv): Record<string, string> {
  const hiveHome = environment.HIVE_HOME;
  const configPath = environment.HIVE_CONFIG;
  const home = environment.HOME;
  const pathEnv = environment.PATH;
  if (!hiveHome || !configPath || !home || !pathEnv) throw new Error("runtime probe service environment incomplete");
  const overrides = Object.fromEntries(
    servicePortKeys.flatMap((key) => (environment[key] === undefined ? [] : [[key, environment[key]!]])),
  );
  const expected = buildServiceEnvironment({ hiveHome, configPath, home, pathEnv, overrides });
  if (!isDeepStrictEqual(selectedEnvironment(environment), expected)) {
    throw new Error("runtime probe environment differs from service environment");
  }
  return expected;
}

export interface OutboundTrunkEvidenceInput {
  sipTrunkId: string;
  twilioNumber: string;
  twilioTrunkDomain: string;
}

export interface ReadOnlyOutboundTrunk {
  sipTrunkId: string;
  numbers: string[];
  address: string;
}

export async function probeOutboundSetup(
  input: OutboundTrunkEvidenceInput,
  listTrunks: () => Promise<readonly ReadOnlyOutboundTrunk[]>,
): Promise<Record<string, unknown>> {
  if (!input.sipTrunkId) throw new Error("outbound trunk ID missing");
  const trunks = await listTrunks();
  const trunk = trunks.find((candidate) => candidate.sipTrunkId === input.sipTrunkId);
  const numberMatches = Boolean(input.twilioNumber) && Boolean(trunk?.numbers.includes(input.twilioNumber));
  const domain = input.twilioTrunkDomain.replace(/^sip:/, "").replace(/\/$/, "");
  const domainMatches = Boolean(domain) && trunk?.address === domain;
  return {
    ok: Boolean(trunk) && numberMatches && domainMatches,
    classification: !trunk
      ? "outbound-trunk-missing"
      : numberMatches && domainMatches
        ? "outbound-read-only-match"
        : "outbound-relationship-mismatch",
    configuredTrunkId: input.sipTrunkId,
    trunkExists: Boolean(trunk),
    numberMatches,
    domainMatches,
  };
}

export interface WorkerHttpEvidence {
  rootStatus: number | null;
  agentName: string | null;
  activeJobs: number | null;
}

export interface WorkerHeartbeatEvidence {
  identity: ReturnType<typeof parseBootIdentity> | null;
  ageMs: number | null;
  fresh: boolean;
  activeCalls: number | null;
}

export function classifyWorkerHeartbeatDocument(value: unknown, now = Date.now()): WorkerHeartbeatEvidence {
  if (!value || typeof value !== "object") return { identity: null, ageMs: null, fresh: false, activeCalls: null };
  const document = value as { supervisorIdentity?: unknown; supervisorUpdatedAt?: unknown };
  let identity: ReturnType<typeof parseBootIdentity>;
  try {
    identity = parseBootIdentity(document.supervisorIdentity);
  } catch {
    return { identity: null, ageMs: null, fresh: false, activeCalls: null };
  }
  const updatedAt =
    document.supervisorUpdatedAt instanceof Date
      ? document.supervisorUpdatedAt.getTime()
      : typeof document.supervisorUpdatedAt === "string"
        ? Date.parse(document.supervisorUpdatedAt)
        : Number.NaN;
  const ageMs = Number.isFinite(updatedAt) ? now - updatedAt : null;
  return {
    identity,
    ageMs,
    fresh: ageMs !== null && ageMs >= -5_000 && ageMs <= 60_000,
    activeCalls:
      Number.isSafeInteger((document as { activeCalls?: unknown }).activeCalls) &&
      ((document as { activeCalls?: number }).activeCalls ?? -1) >= 0
        ? (document as { activeCalls: number }).activeCalls
        : null,
  };
}

export function workerHttpRegistered(evidence: WorkerHttpEvidence): boolean {
  return evidence.rootStatus === 200 && evidence.agentName === "hive-voice" && evidence.activeJobs !== null;
}

export async function probeWorkerHttp(port: number, fetchImpl: FetchLike = fetch): Promise<WorkerHttpEvidence> {
  if (!Number.isSafeInteger(port) || port < 1 || port > 65535) throw new Error("invalid worker health port");
  try {
    const [root, worker] = await Promise.all([
      fetchImpl(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(2_000) }),
      fetchImpl(`http://127.0.0.1:${port}/worker`, { signal: AbortSignal.timeout(2_000) }),
    ]);
    let agentName: string | null = null;
    let activeJobs: number | null = null;
    if (worker.status === 200) {
      try {
        const body = (await worker.json()) as { agent_name?: unknown; active_jobs?: unknown };
        agentName = typeof body.agent_name === "string" ? body.agent_name : null;
        activeJobs =
          typeof body.active_jobs === "number" && Number.isSafeInteger(body.active_jobs) ? body.active_jobs : null;
      } catch {
        // Malformed worker evidence remains unavailable.
      }
    }
    return { rootStatus: root.status, agentName, activeJobs };
  } catch {
    return { rootStatus: null, agentName: null, activeJobs: null };
  }
}

function safeConfigResult(config: typeof import("../config.js").config) {
  const requiredNames = ["SLACK_APP_TOKEN", "SLACK_BOT_TOKEN"];
  if (config.voice.livekit.enabled) {
    requiredNames.push("LIVEKIT_API_KEY", "LIVEKIT_API_SECRET", "HIVE_VOICE_BRIDGE_TOKEN", "DEEPGRAM_API_KEY");
  }
  return {
    ok: true,
    classification: "config-compatible",
    instanceId: config.instance.id,
    database: { name: config.mongo.dbName },
    listeners: {
      background: config.background.port,
      recall: config.recall.monitorPort,
      codeTask: config.codeTask.port,
      ws: config.ws.port,
      adminApi: config.adminApi.port,
      voice: config.voice.port,
      voiceWorker: config.voice.workerPort,
      slackInternal: config.slackInternal.port,
      beekeeper: config.beekeeper.port,
    },
    voice: {
      enabled: config.voice.enabled,
      livekitEnabled: config.voice.livekit.enabled,
      workerPort: config.voice.workerPort,
      hasOutboundTrunkId: Boolean(config.voice.livekit.sipTrunkId),
    },
    requiredSecretNames: requiredNames,
    missingSecretNames: [] as string[],
  };
}

export function runtimeProbeErrorResult(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  const directMissing = message.match(/Missing required env var:\s*([A-Z0-9_]+)/)?.[1];
  const workerMissing = message.match(/voice worker missing required config:\s*([a-zA-Z0-9]+)/)?.[1];
  const workerNames: Record<string, string> = {
    livekitUrl: "voice.livekit.url",
    livekitApiKey: "LIVEKIT_API_KEY",
    livekitApiSecret: "LIVEKIT_API_SECRET",
    deepgramApiKey: "DEEPGRAM_API_KEY",
    bridgeToken: "HIVE_VOICE_BRIDGE_TOKEN",
  };
  const vendorMissing = message.match(/^(CARTESIA_API_KEY|ELEVENLABS_API_KEY) missing/)?.[1];
  const missing = directMissing ?? (workerMissing ? workerNames[workerMissing] : undefined) ?? vendorMissing;
  const knownClassification = [
    "persistence-fault",
    "maintenance-unresolved",
    "maintenance request timed out",
    "stale or mismatched maintenance reply",
  ].find((candidate) => message.includes(candidate));
  return {
    ok: false,
    classification: missing ? "missing-required-key" : (knownClassification ?? "probe-failed"),
    missingSecretNames: missing ? [missing] : [],
  };
}

async function configMode() {
  assertRuntimeProbeEnvironment(process.env);
  const { config } = await import("../config.js");
  return safeConfigResult(config);
}

async function bridgeMode() {
  assertRuntimeProbeEnvironment(process.env);
  const { loadWorkerConfig } = await import("../voice-worker/worker-config.js");
  const config = loadWorkerConfig();
  return { ok: true, ...(await probeBridge(config.bridgeUrl, config.bridgeToken)) };
}

async function workerMode() {
  assertRuntimeProbeEnvironment(process.env);
  const { loadWorkerConfig } = await import("../voice-worker/worker-config.js");
  const config = loadWorkerConfig();
  const identityPath = resolve(config.instanceHome, ".hive-state", "runtime", "voice-worker.json");
  const identity = parseBootIdentity(JSON.parse(readFileSync(identityPath, "utf8")) as unknown);
  if (identity.component !== "voice-worker") throw new Error("worker runtime identity component mismatch");
  const controller = new ServiceController({
    instanceId: config.instanceId,
    hiveHome: config.instanceHome,
    home: process.env.HOME!,
    operationDir: resolve(config.instanceHome, ".hive-state", "deployment", "operations", randomUUID()),
  });
  const observe = async () => {
    const processIdentity = await controller.process(identity.pid);
    if (!processIdentity) throw new Error("voice supervisor is not live");
    return { pid: identity.pid, bootId: identity.bootId };
  };
  const requestedAt = Date.now();
  const operationId = randomUUID();
  const status: MaintenanceReply = await requestMaintenance({
    instanceHome: config.instanceHome,
    instanceId: config.instanceId,
    operationId,
    kind: "status",
    expectedAdmission: "any",
    deadline: requestedAt + 2_000,
    corroborateSupervisor: async () => observe(),
  });
  const http = await probeWorkerHttp(config.healthPort);
  const listener = await controller.listener(config.healthPort, identity.pid);
  const { MongoClient } = await import("mongodb");
  const mongo = new MongoClient(config.mongoUri, { serverSelectionTimeoutMS: 2_000 });
  let heartbeat: WorkerHeartbeatEvidence;
  try {
    await mongo.connect();
    const document = await mongo.db(config.mongoDbName).collection("telemetry").findOne({ kind: "voice_worker_stats" });
    heartbeat = classifyWorkerHeartbeatDocument(document);
  } finally {
    await mongo.close().catch(() => {});
  }
  const maintenanceClassification = status.snapshot.persistenceFault
    ? "persistence-fault"
    : status.snapshot.admission === "closed"
      ? "maintenance-owned"
      : "admission-open";
  return {
    ok: true,
    classification:
      status.ok &&
      workerHttpRegistered(http) &&
      listener.pid === identity.pid &&
      heartbeat.fresh &&
      heartbeat.identity?.pid === identity.pid &&
      heartbeat.identity.bootId === identity.bootId
        ? "worker-registered"
        : "worker-unhealthy",
    supervisor: { pid: identity.pid, bootId: identity.bootId },
    status: {
      requestId: status.requestId,
      operationId: status.operationId,
      requestedAt,
      writtenAt: status.writtenAt,
      snapshot: status.snapshot,
    },
    sdk: http,
    heartbeat,
    socketOwned: listener.pid === identity.pid,
    maintenanceClassification,
  };
}

async function outboundMode() {
  assertRuntimeProbeEnvironment(process.env);
  const { config } = await import("../config.js");
  if (!config.voice.livekit.enabled) throw new Error("voice.livekit.enabled is false");
  if (!config.voice.livekit.sipTrunkId) throw new Error("outbound trunk ID missing");
  const { SipClient } = await import("livekit-server-sdk");
  const client = new SipClient(config.voice.livekit.url, config.voice.livekitApiKey, config.voice.livekitApiSecret);
  return probeOutboundSetup(
    {
      sipTrunkId: config.voice.livekit.sipTrunkId,
      twilioNumber: config.telephony.twilio.number,
      twilioTrunkDomain: config.telephony.twilio.trunkDomain,
    },
    () => client.listSipOutboundTrunk(),
  );
}

export async function runRuntimeProbe(mode: string): Promise<Record<string, unknown>> {
  if (mode !== "config" && mode !== "bridge" && mode !== "worker" && mode !== "outbound") {
    throw new Error("runtime probe mode must be config, bridge, worker, or outbound");
  }
  switch (mode) {
    case "config":
      return configMode();
    case "bridge":
      return bridgeMode();
    case "worker":
      return workerMode();
    case "outbound":
      return outboundMode();
  }
}

async function main(): Promise<void> {
  const stdoutWrite = process.stdout.write;
  const stderrWrite = process.stderr.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  process.stderr.write = (() => true) as typeof process.stderr.write;
  let output: Record<string, unknown>;
  try {
    output = await runRuntimeProbe(process.argv[2] ?? "");
    if (output.ok === false) process.exitCode = 1;
  } catch (error) {
    output = runtimeProbeErrorResult(error);
    process.exitCode = 1;
  } finally {
    process.stdout.write = stdoutWrite;
    process.stderr.write = stderrWrite;
  }
  stdoutWrite.call(process.stdout, `${JSON.stringify(output)}\n`);
}

const invokedPath = process.argv[1] ? realpathSync(process.argv[1]) : "";
if (invokedPath === realpathSync(fileURLToPath(import.meta.url))) void main();
