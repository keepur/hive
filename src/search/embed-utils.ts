/**
 * Shared Ollama embedding utility — used by both ConversationIndex and MemoryEmbedder.
 */

export const EMBED_MODEL = process.env.KB_EMBED_MODEL ?? "bge-large";

export async function embedOllama(ollamaUrl: string, text: string): Promise<number[]> {
  const res = await fetch(`${ollamaUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  return data.embeddings[0];
}
