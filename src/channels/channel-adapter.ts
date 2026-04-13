import type { WorkItem, WorkResult, ChannelKind } from "../types/work-item.js";

/**
 * A ChannelAdapter connects an external system to Hive.
 * It converts external events into WorkItems and delivers responses back.
 */
export interface ChannelAdapter {
  /** Unique adapter identifier — used for routing responses back through the correct adapter */
  readonly id: string;

  /** Which channel kind this adapter handles */
  readonly kind: ChannelKind;

  /** Start listening for incoming messages. Call onWorkItem for each. */
  start(onWorkItem: (item: WorkItem) => void): Promise<void>;

  /** Deliver a response back through this channel */
  deliver(result: WorkResult): Promise<void>;

  /** Clean shutdown */
  stop(): Promise<void>;

  /**
   * Optional: show "agent is thinking" state. `agentId` is the resolved
   * handler id from the dispatcher — guaranteed non-empty and already
   * checked against the registry. Adapters that surface a typing indicator
   * should use this rather than re-deriving from `item.meta`.
   */
  onProcessingStart?(item: WorkItem, agentId: string): Promise<void>;

  /** Optional: processing complete, clear indicators */
  onProcessingEnd?(item: WorkItem, agentId: string): Promise<void>;
}
