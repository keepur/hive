import type { WorkItem, WorkResult, ChannelKind } from "../types/work-item.js";

/**
 * A ChannelAdapter connects an external system to Hive.
 * It converts external events into WorkItems and delivers responses back.
 */
export interface ChannelAdapter {
  /** Which channel kind this adapter handles */
  readonly kind: ChannelKind;

  /** Start listening for incoming messages. Call onWorkItem for each. */
  start(onWorkItem: (item: WorkItem) => void): Promise<void>;

  /** Deliver a response back through this channel */
  deliver(result: WorkResult): Promise<void>;

  /** Clean shutdown */
  stop(): Promise<void>;

  /** Optional: show "agent is thinking" state */
  onProcessingStart?(item: WorkItem): Promise<void>;

  /** Optional: processing complete, clear indicators */
  onProcessingEnd?(item: WorkItem): Promise<void>;
}
