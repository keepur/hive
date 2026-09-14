import type { ReleaseIdentity } from "./clone-promotion.js";
import type { FileSeal, RecordRef, TreeSeal } from "./pilot-records.js";

/** Durable bootstrap work state (chunk 4 Step 4d.1, chunk 5 Task 8 Step 1a.3 Steps 1–2). */
export interface BootstrapWork {
  phase:
    | "preflight"
    | "swept"
    | "archive-retained"
    | "extracted"
    | "installed"
    | "staged"
    | "verified"
    | "renamed"
    | "registering"
    | "finished";
  archiveInput: string;
  reviewedSha256: string;
  reviewedRevision: string;
  sourceHelper: FileSeal | null;
  archiveCopy: FileSeal | null;
  stagingSibling: string | null;
  verification: { release: ReleaseIdentity; checks: string[] } | null;
  rename: {
    from: string;
    to: string;
    identity: { dev: number; ino: number } | null;
    state: "intended" | "observed";
  } | null;
  finalEntry: TreeSeal | null;
  reused: boolean;
  registration: RecordRef | null;
  outcome: "validated" | "aborted" | null;
}
