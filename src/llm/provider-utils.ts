/** KPR-314: shared provider helpers, salvaged from PR #194's provider-utils. */

export function requireApiKey(providerId: string, apiKey: string | undefined): string {
  if (!apiKey) {
    throw new Error(`LLM provider '${providerId}' is missing an API key`);
  }
  return apiKey;
}

export function withTimeout(timeoutMs: number | undefined): AbortSignal | undefined {
  if (!timeoutMs || timeoutMs <= 0) return undefined;
  return AbortSignal.timeout(timeoutMs);
}

export async function parseJsonResponse<T>(response: Response, providerId: string): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => "");
    throw new Error(`LLM provider '${providerId}' returned ${response.status}: ${body.slice(0, 500)}`);
  }
  return (await response.json()) as T;
}
