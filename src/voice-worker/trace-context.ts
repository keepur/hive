import { AsyncLocalStorage } from "node:async_hooks";

export interface BridgeTraceContext {
  readonly workerBootId: string;
  readonly callId: string;
  readonly turnId: string;
}

export interface SynthesisTraceContext {
  readonly workerBootId: string;
  readonly callId: string;
  readonly synthesisId: string;
}

export const bridgeTraceContext = new AsyncLocalStorage<BridgeTraceContext>();
export const synthesisTraceContext = new AsyncLocalStorage<SynthesisTraceContext>();
