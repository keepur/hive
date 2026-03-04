/**
 * HubSpot v3 API Client — read-only CRM data extraction.
 *
 * Wraps the HubSpot REST API with raw fetch(), token-bucket rate limiting,
 * and automatic pagination with 10k-limit splitting for the search endpoint.
 *
 * Env vars:
 *   HUBSPOT_API_KEY — required, private app access token
 */

import { createLogger } from "../logging/logger.js";

const log = createLogger("hubspot-client");

// ── Types ────────────────────────────────────────────────────────────────

export interface HubSpotRecord {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
}

export interface HubSpotProperty {
  name: string;
  label: string;
  type: string;
  fieldType: string;
  groupName: string;
}

export interface HubSpotAssociation {
  toObjectId: string;
  associationTypes: { category: string; typeId: number; label: string | null }[];
}

export interface HubSpotPipeline {
  id: string;
  label: string;
  stages: { id: string; label: string; displayOrder: number }[];
}

export interface HubSpotOwner {
  id: string;
  email: string;
  firstName: string;
  lastName: string;
}

export interface HubSpotEngagement {
  id: string;
  properties: Record<string, string | null>;
  createdAt: string;
  updatedAt: string;
}

// ── Rate Limiter ─────────────────────────────────────────────────────────

class RateLimiter {
  private timestamps: number[] = [];
  private readonly maxRequests = 95;
  private readonly windowMs = 10_000;

  async acquire(): Promise<void> {
    const now = Date.now();
    this.timestamps = this.timestamps.filter(t => t > now - this.windowMs);
    if (this.timestamps.length >= this.maxRequests) {
      const waitMs = this.timestamps[0] + this.windowMs - now + 50;
      log.debug("Rate limiter waiting", { waitMs });
      await new Promise(r => setTimeout(r, waitMs));
    }
    this.timestamps.push(Date.now());
  }
}

// ── Search filter types ──────────────────────────────────────────────────

interface SearchFilter {
  propertyName: string;
  operator: string;
  value?: string;
}

interface SearchFilterGroup {
  filters: SearchFilter[];
}

// ── Client ───────────────────────────────────────────────────────────────

export class HubSpotClient {
  private readonly apiKey: string;
  private readonly rateLimiter = new RateLimiter();

  constructor(apiKey: string) {
    if (!apiKey) throw new Error("HubSpot API key is required");
    this.apiKey = apiKey;
  }

  // ── Core API helper ──────────────────────────────────────────────────

  private async api<T = any>(
    method: string,
    path: string,
    body?: Record<string, unknown>,
    params?: Record<string, string>,
  ): Promise<T> {
    const MAX_RETRIES = 3;
    const url = new URL(`https://api.hubapi.com${path}`);
    if (params) {
      for (const [k, v] of Object.entries(params)) {
        if (v) url.searchParams.append(k, v);
      }
    }

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      await this.rateLimiter.acquire();
      try {
        const res = await fetch(url.toString(), {
          method,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "Content-Type": "application/json",
          },
          ...(body ? { body: JSON.stringify(body) } : {}),
        });

        if (res.ok) {
          return res.json() as Promise<T>;
        }

        // Retry on transient server errors
        if ((res.status === 502 || res.status === 503 || res.status === 429) && attempt < MAX_RETRIES) {
          const backoffMs = Math.min(1000 * 2 ** attempt, 10_000);
          log.warn("Transient API error, retrying", { status: res.status, attempt: attempt + 1, backoffMs });
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }

        const text = await res.text();
        throw new Error(`HubSpot API ${res.status}: ${text}`);
      } catch (err: any) {
        // Retry on network-level failures (fetch failed, ECONNRESET, etc.)
        if (err.message?.startsWith("HubSpot API")) throw err;
        if (attempt < MAX_RETRIES) {
          const backoffMs = Math.min(1000 * 2 ** attempt, 10_000);
          log.warn("Network error, retrying", { error: err.message, attempt: attempt + 1, backoffMs });
          await new Promise(r => setTimeout(r, backoffMs));
          continue;
        }
        throw err;
      }
    }

    throw new Error("Unreachable");
  }

  // ── Properties ───────────────────────────────────────────────────────

  /**
   * Fetch all property definitions for a given object type.
   */
  async getProperties(objectType: string): Promise<HubSpotProperty[]> {
    log.info("Fetching properties", { objectType });
    const data = await this.api<{ results: HubSpotProperty[] }>(
      "GET",
      `/crm/v3/properties/${objectType}`,
    );
    log.info("Fetched properties", { objectType, count: data.results.length });
    return data.results;
  }

  // ── Search / List All ────────────────────────────────────────────────

  /**
   * Yield batches of records via the search API with automatic pagination.
   *
   * HubSpot's search endpoint caps at 10,000 total results. When we hit
   * that ceiling, we bisect the createdate range and recurse into each half,
   * guaranteeing full extraction even for very large datasets.
   *
   * @param objectType  CRM object type (contacts, companies, deals, etc.)
   * @param properties  Which properties to return on each record
   * @param filterGroups  Optional pre-existing filter groups (e.g. lastmodifieddate > X for incremental sync)
   * @param dateRange   Internal: createdate bounds for 10k-split recursion
   */
  async *listAll(
    objectType: string,
    properties: string[],
    filterGroups?: SearchFilterGroup[],
    dateRange?: { gte?: string; lte?: string },
  ): AsyncGenerator<HubSpotRecord[]> {
    const SEARCH_LIMIT = 10_000;
    const PAGE_SIZE = 100;

    // Build filter groups: merge caller-supplied filters with date-range bounds
    const effectiveFilterGroups = buildFilterGroups(filterGroups, dateRange, objectType);

    let after: string | undefined;
    let totalFetched = 0;

    while (true) {
      const searchBody: Record<string, unknown> = {
        properties,
        limit: PAGE_SIZE,
        ...(effectiveFilterGroups.length > 0 ? { filterGroups: effectiveFilterGroups } : {}),
        ...(after ? { after } : {}),
        sorts: [{ propertyName: "createdate", direction: "ASCENDING" }],
      };

      log.debug("Search request", { objectType, body: JSON.stringify(searchBody) });

      const data = await this.api<{
        results: Array<{
          id: string;
          properties: Record<string, string | null>;
          createdAt: string;
          updatedAt: string;
        }>;
        paging?: { next?: { after: string } };
        total: number;
      }>("POST", `/crm/v3/objects/${objectType}/search`, searchBody);

      const batch: HubSpotRecord[] = data.results.map(r => ({
        id: r.id,
        properties: r.properties,
        createdAt: r.createdAt,
        updatedAt: r.updatedAt,
      }));

      if (batch.length > 0) {
        yield batch;
      }

      totalFetched += batch.length;

      // Check if we've hit the 10k ceiling and need to bisect
      if (data.total >= SEARCH_LIMIT && totalFetched >= SEARCH_LIMIT) {
        log.warn("Search hit 10k limit, bisecting date range", {
          objectType,
          total: data.total,
          dateRange,
        });
        yield* this.bisectAndResume(objectType, properties, filterGroups, dateRange, totalFetched);
        return;
      }

      after = data.paging?.next?.after;
      if (!after || batch.length < PAGE_SIZE) {
        log.info("Finished listing", { objectType, totalFetched });
        return;
      }
    }
  }

  /**
   * When search hits 10k results, bisect the createdate range and recurse.
   *
   * If no date range was provided, we use the full 5-year window
   * (2021-01-01 to now). We split into two halves and yield from each.
   */
  private async *bisectAndResume(
    objectType: string,
    properties: string[],
    filterGroups?: SearchFilterGroup[],
    dateRange?: { gte?: string; lte?: string },
    _alreadyFetched?: number,
  ): AsyncGenerator<HubSpotRecord[]> {
    const now = new Date().toISOString();
    const rangeStart = dateRange?.gte ?? "2021-01-01T00:00:00.000Z";
    const rangeEnd = dateRange?.lte ?? now;

    const startMs = new Date(rangeStart).getTime();
    const endMs = new Date(rangeEnd).getTime();

    if (endMs - startMs < 1000) {
      // Range is too small to split further — we've extracted what we can
      log.warn("Date range too narrow to bisect further", { objectType, rangeStart, rangeEnd });
      return;
    }

    const midMs = startMs + Math.floor((endMs - startMs) / 2);
    const midDate = new Date(midMs).toISOString();

    log.info("Bisecting date range", {
      objectType,
      firstHalf: `${rangeStart} .. ${midDate}`,
      secondHalf: `${midDate} .. ${rangeEnd}`,
    });

    // First half: [rangeStart, midDate)
    yield* this.listAll(objectType, properties, filterGroups, {
      gte: rangeStart,
      lte: midDate,
    });

    // Second half: (midDate, rangeEnd]
    // Use GTE on midDate + 1ms to avoid overlap
    const afterMidMs = midMs + 1;
    const afterMidDate = new Date(afterMidMs).toISOString();
    yield* this.listAll(objectType, properties, filterGroups, {
      gte: afterMidDate,
      lte: rangeEnd,
    });
  }

  // ── Associations ─────────────────────────────────────────────────────

  /**
   * Get associations from a single object to another type.
   */
  async getAssociations(
    fromType: string,
    fromId: string,
    toType: string,
  ): Promise<HubSpotAssociation[]> {
    const data = await this.api<{
      results: Array<{
        toObjectId: number;
        associationTypes: Array<{ category: string; typeId: number; label: string | null }>;
      }>;
    }>("GET", `/crm/v4/objects/${fromType}/${fromId}/associations/${toType}`);

    return data.results.map(r => ({
      toObjectId: String(r.toObjectId),
      associationTypes: r.associationTypes,
    }));
  }

  /**
   * Batch-read associations. Chunks into groups of 100 per HubSpot's batch limit.
   * Returns a Map of fromId -> array of associated toObjectIds.
   */
  async getBatchAssociations(
    fromType: string,
    fromIds: string[],
    toType: string,
  ): Promise<Map<string, string[]>> {
    const BATCH_SIZE = 100;
    const result = new Map<string, string[]>();

    for (let i = 0; i < fromIds.length; i += BATCH_SIZE) {
      const chunk = fromIds.slice(i, i + BATCH_SIZE);
      log.debug("Fetching batch associations", {
        fromType,
        toType,
        batchIndex: Math.floor(i / BATCH_SIZE),
        batchSize: chunk.length,
      });

      const data = await this.api<{
        results: Array<{
          from: { id: string };
          to: Array<{ toObjectId: number; associationTypes: unknown[] }>;
        }>;
      }>("POST", `/crm/v4/associations/${fromType}/${toType}/batch/read`, {
        inputs: chunk.map(id => ({ id })),
      });

      for (const entry of data.results) {
        const toIds = entry.to.map(t => String(t.toObjectId));
        const existing = result.get(entry.from.id) ?? [];
        result.set(entry.from.id, [...existing, ...toIds]);
      }
    }

    log.info("Fetched batch associations", {
      fromType,
      toType,
      totalFromIds: fromIds.length,
      totalMappings: result.size,
    });

    return result;
  }

  // ── Pipelines ────────────────────────────────────────────────────────

  /**
   * List all deal pipelines with their stages.
   */
  async listPipelines(): Promise<HubSpotPipeline[]> {
    log.info("Fetching deal pipelines");
    const data = await this.api<{
      results: Array<{
        id: string;
        label: string;
        stages: Array<{ id: string; label: string; displayOrder: number }>;
      }>;
    }>("GET", "/crm/v3/pipelines/deals");

    const pipelines = data.results.map(p => ({
      id: p.id,
      label: p.label,
      stages: p.stages.map(s => ({
        id: s.id,
        label: s.label,
        displayOrder: s.displayOrder,
      })),
    }));

    log.info("Fetched pipelines", { count: pipelines.length });
    return pipelines;
  }

  // ── Owners ───────────────────────────────────────────────────────────

  /**
   * List all owners (users) in the HubSpot account.
   */
  async listOwners(): Promise<HubSpotOwner[]> {
    log.info("Fetching owners");
    const data = await this.api<{
      results: Array<{
        id: string;
        email: string;
        firstName: string;
        lastName: string;
      }>;
    }>("GET", "/crm/v3/owners");

    const owners = data.results.map(o => ({
      id: o.id,
      email: o.email,
      firstName: o.firstName,
      lastName: o.lastName,
    }));

    log.info("Fetched owners", { count: owners.length });
    return owners;
  }

  // ── Engagements ──────────────────────────────────────────────────────

  /**
   * List engagements associated with a specific object.
   *
   * First fetches association IDs via the v4 associations endpoint,
   * then batch-reads the engagement records via the v3 batch read endpoint.
   */
  async listEngagements(
    objectType: string,
    objectId: string,
  ): Promise<HubSpotEngagement[]> {
    log.debug("Fetching engagement associations", { objectType, objectId });

    // Step 1: Get engagement IDs via associations
    const assocData = await this.api<{
      results: Array<{
        toObjectId: number;
        associationTypes: unknown[];
      }>;
    }>("GET", `/crm/v4/objects/${objectType}/${objectId}/associations/engagements`);

    const engagementIds = assocData.results.map(r => String(r.toObjectId));

    if (engagementIds.length === 0) {
      log.debug("No engagements found", { objectType, objectId });
      return [];
    }

    log.debug("Found engagement associations", {
      objectType,
      objectId,
      count: engagementIds.length,
    });

    // Step 2: Batch-read engagement records (chunks of 100)
    const BATCH_SIZE = 100;
    const engagements: HubSpotEngagement[] = [];

    for (let i = 0; i < engagementIds.length; i += BATCH_SIZE) {
      const chunk = engagementIds.slice(i, i + BATCH_SIZE);

      const batchData = await this.api<{
        results: Array<{
          id: string;
          properties: Record<string, string | null>;
          createdAt: string;
          updatedAt: string;
        }>;
      }>("POST", "/crm/v3/objects/engagements/batch/read", {
        inputs: chunk.map(id => ({ id })),
        properties: [
          "hs_engagement_type",
          "hs_timestamp",
          "hs_body_preview",
          "hs_engagement_source",
          "hubspot_owner_id",
          "hs_created_by",
          "hs_modified_by",
          "hs_activity_type",
          "hs_all_assigned_business_unit_ids",
        ],
      });

      for (const r of batchData.results) {
        engagements.push({
          id: r.id,
          properties: r.properties,
          createdAt: r.createdAt,
          updatedAt: r.updatedAt,
        });
      }
    }

    log.info("Fetched engagements", {
      objectType,
      objectId,
      count: engagements.length,
    });

    return engagements;
  }

  // ── Forms & Submissions ───────────────────────────────────────────────

  /**
   * List all marketing forms.
   */
  async listForms(): Promise<Array<{ id: string; name: string; [k: string]: unknown }>> {
    log.info("Fetching forms");
    const forms: Array<{ id: string; name: string; [k: string]: unknown }> = [];
    let after: string | undefined;

    while (true) {
      const data = await this.api<{
        results: Array<{ id: string; name: string; [k: string]: unknown }>;
        paging?: { next?: { after: string } };
      }>("GET", "/marketing/v3/forms", undefined, {
        limit: "100",
        ...(after ? { after } : {}),
      });

      forms.push(...data.results);
      after = data.paging?.next?.after;
      if (!after) break;
    }

    log.info("Fetched forms", { count: forms.length });
    return forms;
  }

  /**
   * List submissions for a specific form. Paginates automatically.
   */
  async listFormSubmissions(
    formId: string,
  ): Promise<Array<{ submittedAt: string; values: Array<{ name: string; value: string }>; [k: string]: unknown }>> {
    const submissions: Array<{ submittedAt: string; values: Array<{ name: string; value: string }>; [k: string]: unknown }> = [];
    let after: string | undefined;

    while (true) {
      const data = await this.api<{
        results: Array<{ submittedAt: string; values: Array<{ name: string; value: string }>; [k: string]: unknown }>;
        paging?: { next?: { after: string } };
      }>("GET", `/form-integrations/v1/submissions/forms/${formId}`, undefined, {
        limit: "50",
        ...(after ? { after } : {}),
      });

      submissions.push(...data.results);
      after = data.paging?.next?.after;
      if (!after || data.results.length < 50) break;
    }

    return submissions;
  }

  // ── Files ─────────────────────────────────────────────────────────────

  /**
   * List all files from HubSpot's file manager. Paginates automatically.
   */
  async *listAllFiles(): AsyncGenerator<Array<{ id: string; name: string; url: string; [k: string]: unknown }>> {
    let after: string | undefined;

    while (true) {
      const data = await this.api<{
        results: Array<{ id: string; name: string; url: string; [k: string]: unknown }>;
        paging?: { next?: { after: string } };
      }>("GET", "/files/v3/files/search", undefined, {
        limit: "100",
        ...(after ? { after } : {}),
      });

      if (data.results.length > 0) {
        yield data.results;
      }

      after = data.paging?.next?.after;
      if (!after || data.results.length < 100) break;
    }
  }
}

// ── Helpers ──────────────────────────────────────────────────────────────

/**
 * Build effective filter groups by merging caller-supplied filters with
 * date-range bounds needed for 10k-limit bisection.
 */
function buildFilterGroups(
  filterGroups?: SearchFilterGroup[],
  dateRange?: { gte?: string; lte?: string },
  objectType?: string,
): SearchFilterGroup[] {
  // Core CRM objects (contacts, companies, deals) use createdate;
  // Activity/engagement objects (tasks, notes, calls, emails, meetings, etc.) use hs_createdate
  const CORE_CRM_OBJECTS = new Set(["contacts", "companies", "deals"]);
  const dateProperty = objectType && !CORE_CRM_OBJECTS.has(objectType) ? "hs_createdate" : "createdate";
  const dateFilters: SearchFilter[] = [];

  if (dateRange?.gte) {
    dateFilters.push({
      propertyName: dateProperty,
      operator: "GTE",
      value: String(new Date(dateRange.gte).getTime()),
    });
  }
  if (dateRange?.lte) {
    dateFilters.push({
      propertyName: dateProperty,
      operator: "LTE",
      value: String(new Date(dateRange.lte).getTime()),
    });
  }

  // No date filters and no caller filters — return empty
  if (dateFilters.length === 0 && (!filterGroups || filterGroups.length === 0)) {
    return [];
  }

  // If caller provided filter groups, inject date filters into each group
  if (filterGroups && filterGroups.length > 0) {
    if (dateFilters.length === 0) return filterGroups;
    return filterGroups.map(group => ({
      filters: [...group.filters, ...dateFilters],
    }));
  }

  // Only date filters, wrap in a single group
  return [{ filters: dateFilters }];
}
