/** Dispatch metadata on a LiveKit job (KPR-322). Split out of main.ts to avoid a session↔entry cycle. */
export interface DispatchMetadata {
  hive_agent_id?: string;
  agent_name?: string;
  to?: string;
  goal?: string;
  context?: string;
  stt?: string;
  tts?: string;
}

export function parseDispatchMetadata(raw: string | undefined): DispatchMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as DispatchMetadata) : {};
  } catch {
    return {};
  }
}
