import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { HubSpotApiClient } from "./hubspot-api-client.js";

// Captured request bodies from each fetch call, so tests can assert on
// filters/sorts without caring about response shape.
interface CapturedCall {
  url: string;
  method: string;
  body: any;
}

function makeFetchStub(): { calls: CapturedCall[]; fetchFn: typeof fetch } {
  const calls: CapturedCall[] = [];
  const fetchFn = (async (input: any, init: any) => {
    const url = typeof input === "string" ? input : input.url;
    const body = init?.body ? JSON.parse(init.body) : null;
    calls.push({ url, method: init?.method ?? "GET", body });
    return {
      ok: true,
      status: 200,
      json: async () => ({ results: [] }),
      text: async () => "",
    } as any;
  }) as typeof fetch;
  return { calls, fetchFn };
}

describe("HubSpotApiClient.listDeals", () => {
  let originalFetch: typeof fetch;
  let calls: CapturedCall[];
  let client: HubSpotApiClient;

  beforeEach(() => {
    originalFetch = globalThis.fetch;
    const stub = makeFetchStub();
    calls = stub.calls;
    globalThis.fetch = stub.fetchFn;
    client = new HubSpotApiClient("test-api-key");
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  function extractFilters(call: CapturedCall): any[] {
    return call.body.filterGroups[0].filters;
  }

  it("sorts by hs_lastmodifieddate DESC by default (not dealname)", async () => {
    await client.listDeals({});

    expect(calls).toHaveLength(1);
    expect(calls[0].body.sorts).toEqual([{ propertyName: "hs_lastmodifieddate", direction: "DESCENDING" }]);
  });

  it("excludes closedwon/closedlost by default when no stages given", async () => {
    await client.listDeals({});

    const filters = extractFilters(calls[0]);
    const closedFilter = filters.find((f: any) => f.propertyName === "dealstage");
    expect(closedFilter).toEqual({
      propertyName: "dealstage",
      operator: "NOT_IN",
      values: ["closedwon", "closedlost"],
    });
  });

  it("does NOT apply the closed-exclusion filter when explicit stages are given", async () => {
    await client.listDeals({ stages: ["closedwon", "qualifiedtobuy"] });

    const filters = extractFilters(calls[0]);
    const stageFilters = filters.filter((f: any) => f.propertyName === "dealstage");
    expect(stageFilters).toHaveLength(1);
    expect(stageFilters[0]).toEqual({
      propertyName: "dealstage",
      operator: "IN",
      values: ["closedwon", "qualifiedtobuy"],
    });
  });

  it("includes closed deals when activeOnly is explicitly false", async () => {
    await client.listDeals({ activeOnly: false });

    const filters = extractFilters(calls[0]);
    const stageFilters = filters.filter((f: any) => f.propertyName === "dealstage");
    expect(stageFilters).toHaveLength(0);
  });

  it("still applies the default exclusion when activeOnly is explicitly true", async () => {
    await client.listDeals({ activeOnly: true });

    const filters = extractFilters(calls[0]);
    const closedFilter = filters.find((f: any) => f.propertyName === "dealstage" && f.operator === "NOT_IN");
    expect(closedFilter).toBeDefined();
  });

  it("always filters to the default sales pipeline", async () => {
    await client.listDeals({});

    const filters = extractFilters(calls[0]);
    expect(filters).toContainEqual({
      propertyName: "pipeline",
      operator: "EQ",
      value: "default",
    });
  });

  it("passes close date range filters through", async () => {
    await client.listDeals({
      closeDateAfter: "2026-01-01",
      closeDateBefore: "2026-12-31",
    });

    const filters = extractFilters(calls[0]);
    expect(filters).toContainEqual({
      propertyName: "closedate",
      operator: "GTE",
      value: "2026-01-01",
    });
    expect(filters).toContainEqual({
      propertyName: "closedate",
      operator: "LTE",
      value: "2026-12-31",
    });
  });

  it("defaults limit to 100 and respects explicit override", async () => {
    await client.listDeals({});
    expect(calls[0].body.limit).toBe(100);

    await client.listDeals({ limit: 25 });
    expect(calls[1].body.limit).toBe(25);
  });

  it("POSTs to the deals search endpoint", async () => {
    await client.listDeals({});

    expect(calls[0].method).toBe("POST");
    expect(calls[0].url).toContain("/crm/v3/objects/deals/search");
  });
});
