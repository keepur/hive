/** Spoken-prefix tail marker after a barge-in (KPR-322 §7). Import-free. */
const TAIL_WORDS = 15;

export function buildInterruptionMarker(spokenText: string): string {
  const words = spokenText.trim().split(/\s+/).filter(Boolean);
  const tail = words.slice(-TAIL_WORDS).join(" ");
  return `[caller interrupted you mid-sentence; they heard your reply only up to: "…${tail}"]`;
}

/**
 * Prefix the next user message when the PREVIOUS agent turn was interrupted.
 * Flows through the engine's extractLatestUserMessage unchanged — zero
 * engine cost.
 */
export function applyInterruptionMarker(userText: string, interruptedSpokenText: string | null): string {
  if (!interruptedSpokenText) return userText;
  return `${buildInterruptionMarker(interruptedSpokenText)} ${userText}`;
}
