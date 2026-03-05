/**
 * HubSpot v3 API Client — lightweight CRUD operations for contacts, deals,
 * notes, tasks, and associations.
 *
 * Uses native fetch() (Node 24) with rate limiting and retry logic.
 *
 * Env vars:
 *   HUBSPOT_API_KEY — HubSpot private app access token
 */

import { createLogger } from "../logging/logger.js";

const log = createLogger("hubspot-api");

// ── Rate Limiter ────────────────────────────────────────────────────────────

class RateLimiter {
  private timestamps: number[] = [];
  private readonly maxRequests = 95;
  private readonly windowMs = 10_000;

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => t > now - this.windowMs);
    if (this.timestamps.length >= this.maxRequests) {
      const waitMs = this.timestamps[0] + this.windowMs - now + 50;
      await new Promise(r => setTimeout(r, waitMs));
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

const CONTACT_PROPERTIES = [
  "firstname",
  "lastname",
  "email",
  "phone",
  "company",
  "jobtitle",
  "lifecyclestage",
];

const DEAL_PROPERTIES = [
  "dealname",
  "dealstage",
  "pipeline",
  "amount",
  "closedate",
  "hubspot_owner_id",
];

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
            await new Promise(r => setTimeout(r, backoffMs));
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
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
        throw err;
      }
    }

    // Should not be reached, but satisfies TypeScript
    throw new Error("HubSpot API: max retries exceeded");
  }

  // ── Contacts ────────────────────────────────────────────────────────────

  async findContact(query: string): Promise<HubSpotObject | null> {
    log.info("Searching for contact", { query });

    const body = {
      filterGroups: [
        {
          filters: [
            { propertyName: "email", operator: "EQ", value: query },
          ],
        },
        {
          filters: [
            { propertyName: "firstname", operator: "CONTAINS_TOKEN", value: query },
          ],
        },
        {
          filters: [
            { propertyName: "lastname", operator: "CONTAINS_TOKEN", value: query },
          ],
        },
      ],
      properties: CONTACT_PROPERTIES,
    };

    const result = await this.api<{ results: HubSpotObject[] }>(
      "POST",
      "/crm/v3/objects/contacts/search",
      body,
    );

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

  // ── Associations ────────────────────────────────────────────────────────

  async associate(
    fromType: string,
    fromId: string,
    toType: string,
    toId: string,
  ): Promise<void> {
    const typeId = ASSOCIATION_TYPES[fromType]?.[toType];
    if (typeId === undefined) {
      throw new Error(`Unknown association: ${fromType} -> ${toType}`);
    }

    log.info("Creating association", { fromType, fromId, toType, toId, typeId });

    await this.api<unknown>(
      "PUT",
      `/crm/v4/objects/${fromType}/${fromId}/associations/${toType}/${toId}`,
      [{ associationCategory: "HUBSPOT_DEFINED", associationTypeId: typeId }],
    );
  }
}
