/**
 * HubSpot v3 API Client — lightweight CRUD operations for contacts, deals,
 * notes, tasks, and associations.
 *
 * Uses native fetch() (Node 24) with rate limiting and retry logic.
 *
 * Env vars:
 *   HUBSPOT_API_KEY — HubSpot private app access token
 */

// Minimal logger (self-contained — no dependency on core src/)
// All levels write to stderr since stdout is the MCP JSON-RPC transport
function createLogger(component: string) {
  const emit = (level: string, msg: string, data?: Record<string, unknown>) => {
    const entry = { ts: new Date().toISOString(), level, component, msg, ...data };
    process.stderr.write(JSON.stringify(entry) + "\n");
  };
  return {
    debug: (msg: string, data?: Record<string, unknown>) => emit("debug", msg, data),
    info: (msg: string, data?: Record<string, unknown>) => emit("info", msg, data),
    warn: (msg: string, data?: Record<string, unknown>) => emit("warn", msg, data),
    error: (msg: string, data?: Record<string, unknown>) => emit("error", msg, data),
  };
}

const log = createLogger("hubspot-api");

// ── Rate Limiter ────────────────────────────────────────────────────────────

class RateLimiter {
  private timestamps: number[] = [];
  private readonly maxRequests = 95;
  private readonly windowMs = 10_000;

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter((t) => t > now - this.windowMs);
    if (this.timestamps.length >= this.maxRequests) {
      const waitMs = this.timestamps[0] + this.windowMs - now + 50;
      await new Promise((r) => setTimeout(r, waitMs));
    }
    this.timestamps.push(Date.now());
  }
}

// ── Types ───────────────────────────────────────────────────────────────────

export interface HubSpotObject {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
}

// ── Association Type IDs ────────────────────────────────────────────────────

const ASSOCIATION_TYPES: Record<string, Record<string, number>> = {
  contact: { deal: 4 },
  deal: { contact: 3 },
  note: { contact: 202, deal: 214 },
  task: { contact: 204, deal: 216 },
};

// ── Default Property Lists ──────────────────────────────────────────────────

const CONTACT_PROPERTIES = ["firstname", "lastname", "email", "phone", "company", "jobtitle", "lifecyclestage"];

const DEAL_PROPERTIES = ["dealname", "dealstage", "pipeline", "amount", "closedate", "hubspot_owner_id"];

// ── Client ──────────────────────────────────────────────────────────────────

export class HubSpotApiClient {
  private readonly apiKey: string;
  private readonly baseUrl = "https://api.hubapi.com";
  private readonly rateLimiter = new RateLimiter();

  constructor(apiKey: string) {
    this.apiKey = apiKey;
  }

  // ── Internal API Helper ─────────────────────────────────────────────────

  private async api<T>(method: string, path: string, body?: unknown): Promise<T> {
    await this.rateLimiter.acquire();

    const url = `${this.baseUrl}${path}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.apiKey}`,
      "Content-Type": "application/json",
    };

    const maxRetries = 3;

    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      try {
        const res = await fetch(url, {
          method,
          headers,
          body: body ? JSON.stringify(body) : undefined,
        });

        if (res.status === 429 || res.status === 502 || res.status === 503) {
          if (attempt < maxRetries) {
            const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 10_000);
            log.warn("Retryable status, backing off", {
              status: res.status,
              attempt,
              backoffMs,
              path,
            });
            await new Promise((r) => setTimeout(r, backoffMs));
            continue;
          }
        }

        if (!res.ok) {
          const text = await res.text();
          throw new Error(`HubSpot API ${res.status}: ${text}`);
        }

        return (await res.json()) as T;
      } catch (err: any) {
        // Retry network errors (not HTTP errors we already threw)
        if (err.message?.startsWith("HubSpot API")) throw err;

        if (attempt < maxRetries) {
          const backoffMs = Math.min(1000 * 2 ** (attempt - 1), 10_000);
          log.warn("Network error, retrying", {
            error: err.message,
            attempt,
            backoffMs,
            path,
          });
          await new Promise((r) => setTimeout(r, backoffMs));
          continue;
        }
        throw err;
      }
    }

    // Should not be reached, but satisfies TypeScript
    throw new Error("HubSpot API: max retries exceeded");
  }

  // ── Contacts ────────────────────────────────────────────────────────────

  async getContact(id: string, properties?: string[]): Promise<HubSpotObject> {
    const props = properties ?? CONTACT_PROPERTIES;
    const queryString = props.length > 0 ? `?properties=${props.join(",")}` : "";
    log.info("Getting contact", { id, properties: props });

    return this.api<HubSpotObject>("GET", `/crm/v3/objects/contacts/${id}${queryString}`);
  }

  async findContact(query: string): Promise<HubSpotObject | null> {
    log.info("Searching for contact", { query });

    const body = {
      filterGroups: [
        {
          filters: [{ propertyName: "email", operator: "EQ", value: query }],
        },
        {
          filters: [{ propertyName: "firstname", operator: "CONTAINS_TOKEN", value: query }],
        },
        {
          filters: [{ propertyName: "lastname", operator: "CONTAINS_TOKEN", value: query }],
        },
      ],
      properties: CONTACT_PROPERTIES,
    };

    const result = await this.api<{ results: HubSpotObject[] }>("POST", "/crm/v3/objects/contacts/search", body);

    return result.results[0] ?? null;
  }

  async createContact(properties: Record<string, string>): Promise<HubSpotObject> {
    log.info("Creating contact", { properties });

    return this.api<HubSpotObject>("POST", "/crm/v3/objects/contacts", { properties });
  }

  async updateContact(id: string, properties: Record<string, string>): Promise<void> {
    log.info("Updating contact", { id, properties });

    await this.api<HubSpotObject>("PATCH", `/crm/v3/objects/contacts/${id}`, { properties });
  }

  // ── Deals ───────────────────────────────────────────────────────────────

  async findDeal(query: string): Promise<HubSpotObject[]> {
    log.info("Searching for deal", { query });

    const body = {
      filterGroups: [
        {
          filters: [{ propertyName: "dealname", operator: "CONTAINS_TOKEN", value: query }],
        },
      ],
      properties: DEAL_PROPERTIES,
      sorts: [{ propertyName: "createdate", direction: "DESCENDING" }],
      limit: 10,
    };

    const result = await this.api<{ results: HubSpotObject[] }>("POST", "/crm/v3/objects/deals/search", body);
    return result.results;
  }

  async listDeals(options: {
    stages?: string[];
    closeDateAfter?: string;
    closeDateBefore?: string;
    limit?: number;
  }): Promise<HubSpotObject[]> {
    log.info("Listing deals", { options });

    const filters: { propertyName: string; operator: string; value?: string; values?: string[] }[] = [
      { propertyName: "pipeline", operator: "EQ", value: "default" },
    ];

    if (options.stages && options.stages.length > 0) {
      filters.push({ propertyName: "dealstage", operator: "IN", values: options.stages });
    }
    if (options.closeDateAfter) {
      filters.push({ propertyName: "closedate", operator: "GTE", value: options.closeDateAfter });
    }
    if (options.closeDateBefore) {
      filters.push({ propertyName: "closedate", operator: "LTE", value: options.closeDateBefore });
    }

    const body = {
      filterGroups: [{ filters }],
      properties: DEAL_PROPERTIES,
      sorts: [{ propertyName: "dealname", direction: "ASCENDING" }],
      limit: options.limit ?? 100,
    };

    const result = await this.api<{ results: HubSpotObject[] }>("POST", "/crm/v3/objects/deals/search", body);
    return result.results;
  }

  async getDeal(id: string, properties?: string[]): Promise<HubSpotObject> {
    const props = properties ?? DEAL_PROPERTIES;
    const queryString = props.length > 0 ? `?properties=${props.join(",")}` : "";
    log.info("Getting deal", { id, properties: props });

    return this.api<HubSpotObject>("GET", `/crm/v3/objects/deals/${id}${queryString}`);
  }

  async createDeal(properties: Record<string, string>): Promise<HubSpotObject> {
    log.info("Creating deal", { properties });

    return this.api<HubSpotObject>("POST", "/crm/v3/objects/deals", { properties });
  }

  async updateDeal(id: string, properties: Record<string, string>): Promise<void> {
    log.info("Updating deal", { id, properties });

    await this.api<HubSpotObject>("PATCH", `/crm/v3/objects/deals/${id}`, { properties });
  }

  // ── Notes ───────────────────────────────────────────────────────────────

  async createNote(body: string): Promise<HubSpotObject> {
    log.info("Creating note", { bodyLength: body.length });

    return this.api<HubSpotObject>("POST", "/crm/v3/objects/notes", {
      properties: {
        hs_note_body: body,
        hs_timestamp: new Date().toISOString(),
      },
    });
  }

  // ── Tasks ───────────────────────────────────────────────────────────────

  async createTask(properties: Record<string, string>): Promise<HubSpotObject> {
    if (!properties.hs_timestamp) {
      properties = { ...properties, hs_timestamp: new Date().toISOString() };
    }
    log.info("Creating task", { properties });

    return this.api<HubSpotObject>("POST", "/crm/v3/objects/tasks", { properties });
  }

  async updateTask(id: string, properties: Record<string, string>): Promise<void> {
    log.info("Updating task", { id, properties });

    await this.api<HubSpotObject>("PATCH", `/crm/v3/objects/tasks/${id}`, { properties });
  }

  async listTasks(options: {
    status?: string;
    ownerId?: string;
    dueBefore?: string;
    dueAfter?: string;
    limit?: number;
  }): Promise<HubSpotObject[]> {
    log.info("Listing tasks", { options });

    const filters: { propertyName: string; operator: string; value?: string; values?: string[] }[] = [];

    if (options.status) {
      filters.push({ propertyName: "hs_task_status", operator: "EQ", value: options.status });
    }
    if (options.ownerId) {
      filters.push({ propertyName: "hubspot_owner_id", operator: "EQ", value: options.ownerId });
    }
    if (options.dueAfter) {
      filters.push({ propertyName: "hs_timestamp", operator: "GTE", value: options.dueAfter });
    }
    if (options.dueBefore) {
      filters.push({ propertyName: "hs_timestamp", operator: "LTE", value: options.dueBefore });
    }

    const body = {
      filterGroups: filters.length > 0 ? [{ filters }] : [],
      properties: [
        "hs_task_subject",
        "hs_task_body",
        "hs_task_status",
        "hs_task_priority",
        "hs_timestamp",
        "hubspot_owner_id",
      ],
      sorts: [{ propertyName: "hs_timestamp", direction: "ASCENDING" }],
      limit: options.limit ?? 100,
    };

    const result = await this.api<{ results: HubSpotObject[] }>("POST", "/crm/v3/objects/tasks/search", body);
    return result.results;
  }

  /**
   * Find active deals (non-closed stages) that have no open tasks associated.
   * Returns deals along with a flag indicating whether any tasks exist at all.
   */
  async getDealsWithoutOpenTasks(options?: {
    stages?: string[];
    limit?: number;
  }): Promise<{ deal: HubSpotObject; taskCount: number; allCompleted: boolean }[]> {
    // Step 1: get active deals
    const activeStages = options?.stages ?? [
      "appointmentscheduled", // S0 Prospect
      "qualifiedtobuy", // S1 Meeting
      "15520138", // S2 Discovery
      "15520119", // S3 Evaluation
      "decisionmakerboughtin", // S4 Proposal
      "63682726", // S5 Invoice
      "149783667", // Sales Nurture
    ];

    const deals = await this.listDeals({ stages: activeStages, limit: options?.limit ?? 200 });
    log.info("Checking tasks for active deals", { dealCount: deals.length });

    // Step 2: for each deal, check associated tasks
    const results: { deal: HubSpotObject; taskCount: number; allCompleted: boolean }[] = [];

    // Process in batches of 10 to respect rate limits
    for (let i = 0; i < deals.length; i += 10) {
      const batch = deals.slice(i, i + 10);
      const batchResults = await Promise.all(
        batch.map(async (deal) => {
          try {
            // Get task associations for this deal
            const assocRes = await this.api<{ results: { id: string }[] }>(
              "GET",
              `/crm/v3/objects/deals/${deal.id}/associations/tasks`,
            );
            const taskIds = assocRes.results.map((r) => r.id);

            if (taskIds.length === 0) {
              return { deal, taskCount: 0, allCompleted: true };
            }

            // Fetch task statuses
            const taskFetches = taskIds.slice(0, 20).map(async (id) => {
              try {
                return await this.api<HubSpotObject>(
                  "GET",
                  `/crm/v3/objects/tasks/${id}?properties=hs_task_status`,
                );
              } catch {
                return null;
              }
            });

            const tasks = (await Promise.all(taskFetches)).filter(Boolean) as HubSpotObject[];
            const hasOpen = tasks.some(
              (t) => t.properties.hs_task_status !== "COMPLETED",
            );

            return { deal, taskCount: tasks.length, allCompleted: !hasOpen };
          } catch {
            // If associations endpoint fails, treat as no tasks
            return { deal, taskCount: 0, allCompleted: true };
          }
        }),
      );
      results.push(...batchResults);
    }

    // Return only deals without open tasks
    return results.filter((r) => r.taskCount === 0 || r.allCompleted);
  }

  // ── Activity History ────────────────────────────────────────────────────

  /**
   * Get all activities (emails, notes, tasks, calls, meetings) associated with
   * a contact or deal, sorted by timestamp descending.
   */
  async getActivities(
    objectType: "contact" | "deal",
    objectId: string,
    options?: { limit?: number },
  ): Promise<{ type: string; timestamp: string; summary: string }[]> {
    const limit = options?.limit ?? 50;
    const engagementTypes = ["emails", "notes", "tasks", "calls", "meetings"] as const;

    // Step 1: get associated IDs for each engagement type
    const associationResults = await Promise.all(
      engagementTypes.map(async (engType) => {
        try {
          const res = await this.api<{ results: { id: string }[] }>(
            "GET",
            `/crm/v3/objects/${objectType}s/${objectId}/associations/${engType}`,
          );
          return { type: engType, ids: res.results.map((r) => r.id) };
        } catch {
          return { type: engType, ids: [] };
        }
      }),
    );

    // Step 2: fetch actual objects (batch per type)
    const propertyMap: Record<string, string[]> = {
      emails: [
        "hs_email_subject",
        "hs_email_text",
        "hs_email_direction",
        "hs_timestamp",
        "hs_email_from_email",
        "hs_email_to_email",
      ],
      notes: ["hs_note_body", "hs_timestamp"],
      tasks: ["hs_task_subject", "hs_task_body", "hs_task_status", "hs_timestamp"],
      calls: ["hs_call_title", "hs_call_body", "hs_call_direction", "hs_call_duration", "hs_timestamp"],
      meetings: ["hs_meeting_title", "hs_meeting_body", "hs_meeting_start_time", "hs_meeting_end_time", "hs_timestamp"],
    };

    const activities: { type: string; timestamp: string; summary: string }[] = [];

    for (const { type: engType, ids } of associationResults) {
      if (ids.length === 0) continue;

      const props = propertyMap[engType] ?? [];
      const propsQuery = props.length > 0 ? `?properties=${props.join(",")}` : "";

      // Fetch individually (batch read endpoint has quirks with engagement types)
      const fetches = ids.slice(0, limit).map(async (id) => {
        try {
          const obj = await this.api<HubSpotObject>("GET", `/crm/v3/objects/${engType}/${id}${propsQuery}`);
          return obj;
        } catch {
          return null;
        }
      });

      const results = (await Promise.all(fetches)).filter(Boolean) as HubSpotObject[];

      for (const obj of results) {
        const p = obj.properties;
        const ts = p.hs_timestamp || obj.createdAt || "";
        let summary = "";

        switch (engType) {
          case "emails": {
            const dir = p.hs_email_direction === "INCOMING_EMAIL" ? "Received" : "Sent";
            const from = p.hs_email_from_email || "unknown";
            const to = p.hs_email_to_email || "unknown";
            const subj = p.hs_email_subject || "(no subject)";
            const body = (p.hs_email_text || "").slice(0, 300);
            summary = `${dir} email — From: ${from} → To: ${to}\n  Subject: ${subj}\n  ${body}`;
            break;
          }
          case "notes": {
            const body = (p.hs_note_body || "").replace(/<[^>]*>/g, "").slice(0, 300);
            summary = `Note: ${body}`;
            break;
          }
          case "tasks": {
            const subj = p.hs_task_subject || "(no subject)";
            const status = p.hs_task_status || "unknown";
            const body = p.hs_task_body ? `\n  ${p.hs_task_body.replace(/<[^>]*>/g, "").slice(0, 200)}` : "";
            summary = `Task [${status}]: ${subj}${body}`;
            break;
          }
          case "calls": {
            const dir = p.hs_call_direction === "INBOUND" ? "Inbound" : "Outbound";
            const dur = p.hs_call_duration ? `${Math.round(Number(p.hs_call_duration) / 1000)}s` : "unknown duration";
            const body = p.hs_call_body ? `\n  ${p.hs_call_body.replace(/<[^>]*>/g, "").slice(0, 200)}` : "";
            summary = `${dir} call (${dur})${body}`;
            break;
          }
          case "meetings": {
            const title = p.hs_meeting_title || "(no title)";
            const start = p.hs_meeting_start_time || "";
            const body = p.hs_meeting_body ? `\n  ${p.hs_meeting_body.replace(/<[^>]*>/g, "").slice(0, 200)}` : "";
            summary = `Meeting: ${title}${start ? ` (${start})` : ""}${body}`;
            break;
          }
        }

        activities.push({ type: engType.replace(/s$/, ""), timestamp: ts, summary });
      }
    }

    // Sort by timestamp descending
    activities.sort((a, b) => (b.timestamp || "").localeCompare(a.timestamp || ""));
    return activities.slice(0, limit);
  }

  // ── Owners ──────────────────────────────────────────────────────────────

  async listOwners(): Promise<{ id: string; email: string; firstName: string; lastName: string }[]> {
    log.info("Listing owners");

    const result = await this.api<{
      results: { id: string; email: string; firstName: string; lastName: string }[];
    }>("GET", "/crm/v3/owners");

    return result.results;
  }

  // ── Associations ────────────────────────────────────────────────────────

  async associate(fromType: string, fromId: string, toType: string, toId: string): Promise<void> {
    const typeId = ASSOCIATION_TYPES[fromType]?.[toType];
    if (typeId === undefined) {
      throw new Error(`Unknown association: ${fromType} -> ${toType}`);
    }

    log.info("Creating association", { fromType, fromId, toType, toId, typeId });

    await this.api<unknown>("PUT", `/crm/v4/objects/${fromType}/${fromId}/associations/${toType}/${toId}`, [
      { associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId },
    ]);
  }
}
