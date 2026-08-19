/**
 * Shared Ollama embedding utility — used by both ConversationIndex and MemoryEmbedder.
 *
 * KPR-241 follow-up. The embedding model (`bge-large`) has a hard 512-token
 * context window (`bert.context_length = 512`), and Ollama's `/api/embed`
 * rejects overlong input with `400 {"error":"the input length exceeds the
 * context length"}`.
 *
 * The obvious reading — "records got too long" — is WRONG, and the original
 * 6000-char cap was built on it. Measured against the live Ollama 0.21.2 on the
 * Catalyst box, the actual behaviour is:
 *
 *   - `truncate` defaults to true, and for pure-ASCII text it works perfectly.
 *     60,000 chars of English embeds fine. Length alone NEVER triggers the 400.
 *   - Any non-ASCII character degrades that truncation, and the failure
 *     threshold scales inversely with non-ASCII density:
 *
 *       0.25% non-ASCII (1 em-dash / 400 chars) -> 400s above ~2500 chars
 *       1.9%             (1 em-dash /  50 chars) -> 400s above ~2215 chars
 *       8.3%             (1 em-dash /  10 chars) -> 400s above ~1532 chars
 *      14.3%             (1 em-dash /   4 chars) -> 400s above ~1191 chars
 *       ~100% (CJK)                              -> 400s above  ~500 chars
 *
 * Ollama truncates using a character/byte estimate that under-counts the tokens
 * a multi-byte sequence actually produces, so the "truncated" input still
 * overflows the window. Setting `truncate: true` explicitly does not help — it
 * is already the default and is precisely what is miscounting.
 *
 * This is why the 6000-char cap never fired: real failing records are 1.7k-17k
 * chars of ordinary English prose whose only non-ASCII content is em-dashes,
 * curly quotes, ellipses and checkmarks — well under 6000, so the cap passed
 * them straight through to a guaranteed 400. It also only guarded `upsert()`,
 * leaving `search()` — which embeds full record content during the burst-
 * similarity check — completely unprotected.
 *
 * Fix: chunk input below the window, embed every chunk, and mean-pool the chunk
 * vectors into a single unit-length vector. Output dimensionality is unchanged
 * (1024), so no stored vector is invalidated and no migration is required.
 * Unlike truncation, every part of the input contributes to the final vector.
 *
 * Chunks are sized by ESTIMATED TOKEN COST rather than raw character count,
 * because the measurements above show characters are not a usable proxy: the
 * safe size swings 5x between ASCII prose and CJK. Any chunk the server still
 * rejects is split adaptively at runtime as a backstop.
 */

export const EMBED_MODEL = process.env.KB_EMBED_MODEL ?? "bge-large";

/**
 * Token budget per chunk. The model window is 512; we target 384 to leave room
 * for the tokenizer's added [CLS]/[SEP] markers and for the cost model below
 * under-estimating on unusual input.
 *
 * Validated against the measured thresholds: this budget yields ~1600 chars for
 * pure ASCII (never fails), ~1075 chars at 14.3% non-ASCII (fails at 1191), and
 * ~384 chars for pure CJK (fails at ~500) — under the empirical limit across the
 * whole density range.
 */
export const EMBED_TOKEN_BUDGET = parseInt(process.env.EMBED_TOKEN_BUDGET ?? "384", 10);

/**
 * Estimated token cost of a single ASCII character. BERT-family wordpiece
 * tokenizers average ~4 chars/token on English prose.
 */
const ASCII_TOKEN_COST = 0.25;

/**
 * Estimated token cost of a single non-ASCII character. CJK runs about 1
 * token/char, and characters that fall outside the model vocabulary decompose
 * into multiple byte-level tokens, so 1.0 is the conservative floor — this is
 * the term that the old character-only sizing was missing entirely.
 */
const NON_ASCII_TOKEN_COST = 1.0;

/** Guard against pathological recursion when adaptively splitting a chunk. */
const MAX_SPLIT_DEPTH = 6;

/** Below this we stop splitting and give up on the chunk rather than loop. */
const MIN_CHUNK_CHARS = 32;

/**
 * Estimate the token cost of `text` using the density-aware model described
 * above. Deliberately cheap (a single pass, no tokenizer dependency) and biased
 * to over-estimate, since over-estimating costs an extra chunk while
 * under-estimating costs a 400.
 */
export function estimateTokens(text: string): number {
  let cost = 0;
  for (let i = 0; i < text.length; i++) {
    cost += text.charCodeAt(i) < 128 ? ASCII_TOKEN_COST : NON_ASCII_TOKEN_COST;
  }
  return Math.ceil(cost);
}

/**
 * Largest character count whose estimated token cost still fits `budget`, given
 * the non-ASCII density of `sample`. Used to translate the token budget into the
 * character-oriented cut points that chunking actually operates on.
 */
function charsForBudget(sample: string, budget: number): number {
  if (sample.length === 0) return budget * 4;
  const avg = estimateTokens(sample) / sample.length;
  return Math.max(MIN_CHUNK_CHARS, Math.floor(budget / avg));
}

/**
 * Split text into chunks that each fit within `budget` estimated tokens,
 * preferring to break on paragraph, then sentence, then word boundaries so each
 * chunk stays semantically coherent. Falls back to a hard character cut for
 * inputs with no whitespace at all (base64 blobs, minified payloads, unbroken
 * CJK).
 *
 * The character limit is recomputed per chunk from the local non-ASCII density
 * rather than fixed for the whole input, so a mostly-ASCII document containing
 * one dense CJK paragraph tightens the limit for that paragraph only instead of
 * penalising (or, worse, overflowing on) the entire document.
 */
export function chunkText(text: string, budget: number = EMBED_TOKEN_BUDGET): string[] {
  if (budget <= 0) throw new Error("chunkText: budget must be positive");
  if (text.length === 0) return [];
  if (estimateTokens(text) <= budget) return [text];

  const chunks: string[] = [];
  let rest = text;

  while (rest.length > 0) {
    // Size this chunk from the density of the text immediately ahead. The
    // initial guess is generous; the loop below tightens it until it fits.
    let maxChars = Math.min(rest.length, charsForBudget(rest.slice(0, budget * 4), budget));
    while (maxChars > MIN_CHUNK_CHARS && estimateTokens(rest.slice(0, maxChars)) > budget) {
      maxChars = Math.floor(maxChars * 0.8);
    }

    if (maxChars >= rest.length) {
      const last = rest.trim();
      if (last) chunks.push(last);
      break;
    }

    const window = rest.slice(0, maxChars);
    // Prefer the latest natural boundary inside the window; only accept it if it
    // isn't so early that we'd emit a tiny chunk and churn.
    const minCut = Math.floor(maxChars / 2);
    let cut = -1;
    for (const sep of ["\n\n", "\n", ". ", "! ", "? ", "; ", " "]) {
      const idx = window.lastIndexOf(sep);
      if (idx >= minCut) {
        cut = idx + sep.length;
        break;
      }
    }
    if (cut <= 0) cut = maxChars; // no usable boundary — hard cut

    const piece = rest.slice(0, cut).trim();
    if (piece) chunks.push(piece);
    rest = rest.slice(cut);
  }

  return chunks;
}

/** Component-wise mean of equal-length vectors, renormalized to unit length. */
export function meanPool(vectors: number[][]): number[] {
  if (vectors.length === 0) throw new Error("meanPool: no vectors to pool");
  if (vectors.length === 1) return vectors[0];

  const dim = vectors[0].length;
  const acc = new Array<number>(dim).fill(0);
  for (const v of vectors) {
    if (v.length !== dim) {
      throw new Error(`meanPool: dimension mismatch (${v.length} vs ${dim})`);
    }
    for (let i = 0; i < dim; i++) acc[i] += v[i];
  }

  let norm = 0;
  for (let i = 0; i < dim; i++) {
    acc[i] /= vectors.length;
    norm += acc[i] * acc[i];
  }
  norm = Math.sqrt(norm);
  // A zero vector cannot be normalized; return it as-is rather than emit NaNs.
  if (norm === 0) return acc;
  for (let i = 0; i < dim; i++) acc[i] /= norm;
  return acc;
}

/** True when Ollama rejected the input for exceeding the model context window. */
function isContextOverflow(message: string): boolean {
  return message.includes("exceeds the context length") || message.includes("context length");
}

/** POST one batch of inputs to Ollama and return their vectors, in order. */
async function embedBatch(ollamaUrl: string, inputs: string[]): Promise<number[][]> {
  const res = await fetch(`${ollamaUrl}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: EMBED_MODEL, input: inputs }),
  });
  if (!res.ok) throw new Error(`Ollama embed ${res.status}: ${await res.text()}`);
  const data = await res.json();
  if (!Array.isArray(data?.embeddings) || data.embeddings.length !== inputs.length) {
    throw new Error(`Ollama embed: expected ${inputs.length} embeddings, got ${data?.embeddings?.length ?? 0}`);
  }
  return data.embeddings;
}

/**
 * Embed one chunk, halving the token budget and retrying if the server still
 * reports a context overflow. The cost model is an estimate, so genuinely
 * pathological input can still overflow; halving converges in a few rounds.
 * Returns every resulting sub-vector for the caller to pool.
 */
async function embedChunkAdaptive(
  ollamaUrl: string,
  chunk: string,
  budget: number = EMBED_TOKEN_BUDGET,
  depth: number = 0,
): Promise<number[][]> {
  try {
    return await embedBatch(ollamaUrl, [chunk]);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!isContextOverflow(message) || depth >= MAX_SPLIT_DEPTH || chunk.length <= MIN_CHUNK_CHARS) {
      throw err;
    }
    const nextBudget = Math.max(1, Math.floor(budget / 2));
    const halves = chunkText(chunk, nextBudget);
    // Degenerate case: nothing actually got smaller, so retrying would loop.
    if (halves.length < 2) throw err;
    const out: number[][] = [];
    for (const half of halves) {
      out.push(...(await embedChunkAdaptive(ollamaUrl, half, nextBudget, depth + 1)));
    }
    return out;
  }
}

/**
 * Embed arbitrary-length text into a single vector.
 *
 * Short inputs take exactly the same single-request path as before. Long inputs
 * are chunked, embedded in one batched request, and mean-pooled — so callers
 * see an identical contract (one vector of the model's native dimensionality)
 * regardless of input size.
 */
export async function embedOllama(ollamaUrl: string, text: string): Promise<number[]> {
  const chunks = chunkText(text);
  if (chunks.length === 0) throw new Error("Ollama embed: refusing to embed empty text");

  // Fast path — unchanged behaviour for the overwhelming majority of inputs.
  if (chunks.length === 1) {
    const [vector] = await embedChunkAdaptive(ollamaUrl, chunks[0]);
    return vector;
  }

  let vectors: number[][];
  try {
    vectors = await embedBatch(ollamaUrl, chunks);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!isContextOverflow(message)) throw err;
    // At least one chunk cost more tokens than the cost model estimated.
    vectors = [];
    for (const chunk of chunks) {
      vectors.push(...(await embedChunkAdaptive(ollamaUrl, chunk)));
    }
  }
  return meanPool(vectors);
}
