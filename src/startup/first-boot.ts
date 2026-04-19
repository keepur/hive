/**
 * First-boot detection and CoS greeting dispatch.
 *
 * On a fresh hive, the CoS should proactively greet the owner and offer
 * onboarding. This module checks a flag in MongoDB and dispatches a
 * synthetic WorkItem to the CoS home channel if it's day zero.
 */

import { createLogger } from "../logging/logger.js";
import type { MemoryManager } from "../memory/memory-manager.js";
import type { AgentRegistry } from "../agents/agent-registry.js";
import type { Dispatcher } from "../channels/dispatcher.js";
import type { WorkItem } from "../types/work-item.js";

const log = createLogger("first-boot");

const FLAG_PATH = "hive/first-boot-greeting-sent";
const COS_AGENT_ID = "chief-of-staff";

export async function checkFirstBoot(
  memoryManager: MemoryManager,
  registry: AgentRegistry,
  dispatcher: Dispatcher,
  channelIdByName: Map<string, string>,
): Promise<void> {
  // 1. Check flag — skip entirely on MongoDB error
  let flagValue: string | null;
  try {
    flagValue = await memoryManager.read(FLAG_PATH);
  } catch (err) {
    log.warn("First-boot flag read failed — skipping check this startup", {
      error: String(err),
    });
    return;
  }

  if (flagValue) {
    log.debug("First-boot greeting already sent — skipping");
    return;
  }

  // 2. Resolve CoS home channel
  const cosAgent = registry.get(COS_AGENT_ID);
  const cosHomeChannelName = cosAgent?.homeBase ?? cosAgent?.channels?.[0];

  if (!cosHomeChannelName) {
    log.warn("First-boot: CoS agent has no homeBase or channels — skipping, will retry next startup");
    return;
  }

  const cosHomeChannelId = channelIdByName.get(cosHomeChannelName);
  if (!cosHomeChannelId) {
    log.warn("First-boot: could not resolve channel ID for CoS home channel", {
      channelName: cosHomeChannelName,
    });
    return;
  }

  // 3. Optimistic lock: set flag BEFORE dispatching
  try {
    await memoryManager.write(FLAG_PATH, "true", "system");
  } catch (err) {
    log.error("First-boot: flag write failed — aborting greeting dispatch", {
      error: String(err),
    });
    return;
  }

  // 4. Dispatch synthetic WorkItem
  const ts = Date.now();
  const workItem: WorkItem = {
    id: `system:first-boot:${ts}`,
    text: "First boot detected. Greet the owner and offer onboarding.",
    source: {
      kind: "slack",
      id: cosHomeChannelId,
      label: cosHomeChannelName,
      adapterId: "slack",
    },
    sender: "system",
    threadId: `first-boot:${ts}`,
    timestamp: new Date(),
    meta: {
      targetAgentId: COS_AGENT_ID,
      systemTrigger: "first-boot",
    },
  };

  log.info("First-boot: dispatching CoS greeting", {
    channel: cosHomeChannelName,
    channelId: cosHomeChannelId,
  });

  dispatcher.dispatch(workItem).catch((err) => {
    log.error("First-boot greeting dispatch failed", { error: String(err) });
  });
}
