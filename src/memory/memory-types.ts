import type { ObjectId } from "mongodb";

export type MemoryType = "fact" | "task" | "interaction" | "preference" | "decision" | "summary";
export type MemoryImportance = "critical" | "high" | "medium" | "low";
export type MemoryTier = "hot" | "warm" | "cold";

export interface MemoryRecord {
  _id?: ObjectId;
  agentId: string;
  content: string;
  type: MemoryType;
  topic: string;
  importance: MemoryImportance;
  tier: MemoryTier;
  createdAt: Date;
  updatedAt: Date;
  lastAccessedAt: Date;
  accessCount: number;
  sourceChannel?: string;
  sourceThread?: string;
  pinned: boolean;
  supersededBy?: ObjectId;
  summaryGroup?: ObjectId;
  summarized: boolean;
  summarizedAt?: Date;
  qdrantPointId: string;
  purged?: boolean;
  purgedAt?: Date;
  needsReview?: boolean; // Contradiction detection couldn't resolve automatically
}

export interface MemoryRecordInput {
  content: string;
  type: MemoryType;
  topic: string;
  importance: MemoryImportance;
}

export interface MemoryRecallFilters {
  type?: MemoryType;
  topic?: string;
  tier?: MemoryTier;
  importance?: MemoryImportance;
  limit?: number;
}

export interface PurgeFilters {
  topic?: string;
  type?: MemoryType;
  importance?: MemoryImportance;
  tier?: MemoryTier;
  olderThan?: Date;
}

export interface MemoryRecallResult extends MemoryRecord {
  score: number;
}

export interface MemoryLifecycleConfig {
  hotBudgetTokens: number;
  sweepIntervalHours: number;
  hotThreshold: number;
  warmThreshold: number;
  recencyHalfLifeDays: number;
  coldSummaryMinRecords: number;
  coldRetentionDays: number;
  purgeRetentionDays: number;
}

export interface DreamConfig {
  enabled: boolean;
  /** Preferred name for the required idle window before autoDream can run. */
  quietPeriodMinutes?: number;
  /** Legacy name kept for config compatibility; use quietPeriodMinutes instead. */
  idleThresholdMinutes?: number;
  cooldownMinutes: number;
  /** Minimum changed memory records since an agent's last successful autoDream. */
  minNewMemories?: number;
  similarityThreshold: number;
  patternMinCount: number;
  maxClustersPerRun: number;
  maxContradictionPairsPerRun: number;
  maxPromotionsPerRun: number;
  /** Total budget for one autoDream invocation across all agents/calls. */
  maxRunBudgetUsd?: number;
  /** Per-SDK-call safety cap inside the run-level budget. */
  maxCallBudgetUsd?: number;
  /** Legacy per-call budget field; use maxRunBudgetUsd + maxCallBudgetUsd instead. */
  maxBudgetUsd?: number;
}

export interface DreamResult {
  merged: number;
  contradictions: number;
  promoted: number;
  flaggedForReview: number;
  errors: string[];
  skippedAgents?: number;
  spentUsd?: number;
  budgetUsd?: number;
  llmCalls?: number;
}

export const IMPORTANCE_WEIGHTS: Record<MemoryImportance, number> = {
  critical: 1.0,
  high: 0.75,
  medium: 0.5,
  low: 0.25,
};

export const TYPE_WEIGHTS: Record<MemoryType, number> = {
  decision: 1.0,
  fact: 0.8,
  preference: 0.8,
  summary: 0.6,
  task: 0.5,
  interaction: 0.3,
};
