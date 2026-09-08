export const BUILTIN_CATALOG_PROVIDERS = ["claude", "grok", "codex"] as const;
export type CatalogProvider = (typeof BUILTIN_CATALOG_PROVIDERS)[number];
export type FailureCode =
  "auth" | "client-version" | "http" | "timeout" | "canceled" | "malformed" | "empty" | "too-large" | "storage";
export interface SafeCatalogError {
  code: FailureCode;
  message: string;
  httpStatus?: number;
}
export interface DiscoveredModel {
  id: string;
  displayName: string;
}
export interface ModelInput extends DiscoveredModel {
  notes?: string;
}
export interface CatalogModel extends ModelInput {
  addedAt: Date;
}
export type CatalogSource = "manual" | "discovery";
export interface DiscoveryAttempt {
  provider: CatalogProvider;
  attemptId: string;
  startedAt: Date;
  leaseExpiresAt: Date;
}
// Opaque, in-process input from readCatalogState; never serialize or persist it.
declare const acquisitionObservationBrand: unique symbol;
export interface AcquisitionObservation {
  readonly [acquisitionObservationBrand]: true;
}
export type BeginDiscoveryInput = Omit<DiscoveryAttempt, "provider"> & {
  observed: AcquisitionObservation;
};
export interface CatalogScan {
  attemptId: string;
  startedAt: Date;
  leaseExpiresAt?: Date;
  finishedAt?: Date;
  outcome: "running" | "succeeded" | "failed";
  lastSucceededAt?: Date;
  error?: SafeCatalogError;
}
export interface CatalogDiff {
  bootstrap: boolean;
  added: string[];
  removed: string[];
}
export interface CatalogChange extends CatalogDiff {
  _id: string;
  provider: string;
  revision: number;
  snapshotId: string;
  createdAt: Date;
  source: CatalogSource;
  updatedBy: string;
  modelCount: number;
}
export interface ChangeDelivery {
  state: "pending";
  attempts: number;
  nextAttemptAt: Date;
}
export interface CatalogChangeDoc extends CatalogChange {
  delivery: ChangeDelivery;
}
export interface CatalogVersion extends CatalogChange {
  snapshot: CatalogModel[];
  changeSummary: string;
}
export interface PendingExport {
  version: CatalogVersion;
  change?: CatalogChange;
}
export interface CatalogDoc {
  _id: string;
  provider: string;
  models?: CatalogModel[];
  updatedAt?: Date;
  updatedBy?: string;
  source?: CatalogSource;
  revision?: number;
  commitId?: string;
  snapshotId?: string;
  scan?: CatalogScan;
  pendingExport?: PendingExport;
}
export interface ManualReplacement {
  provider: string;
  models: ModelInput[];
  updatedBy: string;
  changeSummary?: string;
}
export interface CatalogIdentity {
  commitId?: string;
  revision: number;
  snapshotId: string;
}
export type ReplacementResult =
  | ({ kind: "committed"; commitId: string; recoveryPending: boolean } & CatalogIdentity & CatalogDiff)
  | ({ kind: "unchanged"; lastSucceededAt: Date } & CatalogIdentity)
  | { kind: "superseded" }
  | { kind: "not-committed"; error: SafeCatalogError; retriable: boolean }
  | { kind: "commit-unknown"; operationId: string; error: SafeCatalogError };
export type RecoveryResult =
  { provider: string; kind: "recovered" } | { provider: string; kind: "pending" | "error"; error: SafeCatalogError };
export type BeginResult = { kind: "started"; attempt: DiscoveryAttempt } | { kind: "busy" };
export type FailResult = { kind: "recorded" } | { kind: "superseded" };
