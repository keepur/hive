/**
 * Voice-worker configuration (KPR-322). Reuses the engine's config loader —
 * hive.yaml + .env + Honeypot (env-first, Keychain-second) — so the worker
 * resolves vendor keys exactly the way the engine does. Cloud-model agents
 * never see these values; they live in this worker process only.
 */
import { config, resolveSecretEnv } from "../config.js";
import { createLogger } from "../logging/logger.js";

const log = createLogger("voice-worker-config");

export interface WorkerConfig {
  livekitUrl: string;
  livekitApiKey: string;
  livekitApiSecret: string;
  sipTrunkId: string;
  inboundAgents: Record<string, string>;
  agentVoices: Record<string, string>;
  defaultStt: string;
  defaultTts: string;
  deepgramApiKey: string;
  cartesiaApiKey: string;
  elevenlabsApiKey: string;
  bridgeToken: string;
  bridgeUrl: string; // http://127.0.0.1:<voice.port>/v1/chat/completions
  mongoUri: string;
  mongoDbName: string;
}

/** Map hive worker config onto @livekit/agents WorkerOptions / ServerOptions auth fields. */
export function livekitServerAuth(wc: Pick<WorkerConfig, "livekitUrl" | "livekitApiKey" | "livekitApiSecret">): {
  wsURL: string;
  apiKey: string;
  apiSecret: string;
} {
  return { wsURL: wc.livekitUrl, apiKey: wc.livekitApiKey, apiSecret: wc.livekitApiSecret };
}

export function loadWorkerConfig(): WorkerConfig {
  const lk = config.voice.livekit;
  if (!lk.enabled) throw new Error("voice.livekit.enabled is false — voice worker refusing to start");
  const wc: WorkerConfig = {
    livekitUrl: lk.url,
    livekitApiKey: config.voice.livekitApiKey,
    livekitApiSecret: config.voice.livekitApiSecret,
    sipTrunkId: lk.sipTrunkId,
    inboundAgents: lk.inboundAgents,
    agentVoices: lk.agentVoices,
    defaultStt: lk.defaultStt,
    defaultTts: lk.defaultTts,
    deepgramApiKey: resolveSecretEnv("DEEPGRAM_API_KEY"),
    cartesiaApiKey: resolveSecretEnv("CARTESIA_API_KEY"),
    elevenlabsApiKey: resolveSecretEnv("ELEVENLABS_API_KEY"),
    bridgeToken: config.voice.bridgeToken,
    bridgeUrl: `http://127.0.0.1:${config.voice.port}/v1/chat/completions`,
    mongoUri: config.mongo.uri,
    mongoDbName: config.mongo.dbName,
  };
  for (const [k, v] of Object.entries({
    livekitUrl: wc.livekitUrl,
    livekitApiKey: wc.livekitApiKey,
    livekitApiSecret: wc.livekitApiSecret,
    deepgramApiKey: wc.deepgramApiKey,
    bridgeToken: wc.bridgeToken,
  })) {
    if (!v) throw new Error(`voice worker missing required config: ${k}`);
  }
  if (wc.defaultTts.startsWith("cartesia/") && !wc.cartesiaApiKey)
    throw new Error("CARTESIA_API_KEY missing for default TTS cell");
  if (wc.defaultTts.startsWith("elevenlabs/") && !wc.elevenlabsApiKey)
    throw new Error("ELEVENLABS_API_KEY missing for default TTS cell");
  if (!wc.cartesiaApiKey || !wc.elevenlabsApiKey) log.warn("One TTS vendor key missing — that A/B cell unavailable");
  return wc;
}
