import type { JobContext } from "@livekit/agents";

function latch(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

export interface JobReporter {
  entered(): void;
  completed(): void;
}

export async function withJobLifecycle(
  ctx: Pick<JobContext, "addShutdownCallback">,
  reporter: JobReporter,
  work: (hooks: {
    delegateCleanup(): () => void;
    setEarlyCleanup(cleanup: () => Promise<void>): void;
  }) => Promise<void>,
): Promise<void> {
  const entrySettled = latch();
  const cleanupDone = latch();
  let delegated = false;
  let earlyCleanup = async (): Promise<void> => {};
  ctx.addShutdownCallback(async () => {
    await entrySettled.promise;
    if (delegated) await cleanupDone.promise;
    else await earlyCleanup();
    reporter.completed();
  });
  try {
    reporter.entered();
    await work({
      delegateCleanup() {
        delegated = true;
        return cleanupDone.resolve;
      },
      setEarlyCleanup(cleanup) {
        earlyCleanup = cleanup;
      },
    });
  } finally {
    entrySettled.resolve();
  }
}
