import type { Collection, Db } from "mongodb";
import { createLogger } from "../logging/logger.js";

const log = createLogger("workflow-events");

interface EventDelivery {
  agentId: string;
  status: "pending";
}

interface AgentEvent {
  type: string;
  domain: string;
  payload: Record<string, unknown>;
  sourceAgentId: string;
  createdAt: Date;
  hasPending: boolean;
  deliveries: EventDelivery[];
}

/**
 * Emits workflow events by writing directly to agent_events collection.
 * Mirrors the pattern in event-bus-mcp-server.ts.
 */
export class WorkflowEventEmitter {
  private events: Collection<AgentEvent>;
  private sourceAgentId: string;
  private subscriberMap: Record<string, string[]>;

  constructor(db: Db, sourceAgentId: string, subscriberMapJson: string) {
    this.events = db.collection<AgentEvent>("agent_events");
    this.sourceAgentId = sourceAgentId;

    try {
      this.subscriberMap = JSON.parse(subscriberMapJson || "{}");
    } catch {
      this.subscriberMap = {};
    }
  }

  async emit(type: string, payload: Record<string, unknown>): Promise<string | null> {
    const domain = type.split(":")[0];
    const subscribers = (this.subscriberMap[domain] ?? []).filter((id) => id !== this.sourceAgentId);

    if (subscribers.length === 0) {
      log.debug("No subscribers for workflow event", { type, domain });
      return null;
    }

    const deliveries: EventDelivery[] = subscribers.map((agentId) => ({
      agentId,
      status: "pending" as const,
    }));

    const doc: AgentEvent = {
      type,
      domain,
      payload,
      sourceAgentId: this.sourceAgentId,
      createdAt: new Date(),
      hasPending: true,
      deliveries,
    };

    const result = await this.events.insertOne(doc as any);
    const eventId = result.insertedId.toHexString();
    log.info("Workflow event emitted", { type, eventId: `evt_${eventId.slice(-8)}`, subscribers: subscribers.length });
    return eventId;
  }
}
