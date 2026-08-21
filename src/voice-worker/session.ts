import type { JobContext } from "@livekit/agents";
import type { VendorCell } from "./cells.js";
import type { DispatchMetadata } from "./dispatch-meta.js";
import type { WorkerConfig } from "./worker-config.js";

/** Task 7 replaces this body. Stub keeps Task 5 typecheck/bundle green. */
export async function runCallSession(
  _ctx: JobContext,
  _wc: WorkerConfig,
  _meta: DispatchMetadata,
  _cell: VendorCell,
): Promise<void> {
  throw new Error("runCallSession is Task 7");
}
