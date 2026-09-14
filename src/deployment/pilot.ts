import type { CapturePreparation, FileSeal, ProcessSeal, RecordRef } from "./pilot-records.js";

/** Durable registry work state (chunk 5 Task 8 Step 1a.3 Step 1). */
export interface RegistryWork {
  command: "capture-pilot" | "inventory-pilot" | "prepare-legacy-hold" | "verify-legacy-hold" | "release-legacy-hold";
  phase: "reading" | "probing" | "closing" | "registering" | "releasing" | "finished";
  selectedSnapshot: RecordRef | null;
  selectedHold: RecordRef | null;
  bootstrap: RecordRef | null;
  capture: CapturePreparation | null;
  result: FileSeal | null;
  barrier: null | {
    operationId: string;
    supervisor: ProcessSeal;
    bootId: string;
    descriptor: FileSeal | null;
    healthListenerPort: number;
    state: "close-intended" | "closed" | "release-intended" | "released" | "supervisor-exited";
    terminalEvidence: FileSeal | null;
  };
  outcome: "record-committed" | "assessment-complete" | "migration-pending" | "aborted" | null;
}
