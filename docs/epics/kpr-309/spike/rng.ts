/**
 * KPR-310 spike — seeded PRNG + deterministic nonce derivation.
 * Throwaway harness (see README). No imports from src/**.
 */

/** mulberry32 — small deterministic PRNG. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a fold of a tag string into a 32-bit seed. */
export function hashTag(tag: string, seed: number): number {
  let h = seed >>> 0 || 0x811c9dc5;
  for (let i = 0; i < tag.length; i++) {
    h = Math.imul(h ^ tag.charCodeAt(i), 0x01000193) >>> 0;
  }
  return h >>> 0;
}

/** Deterministic 8-char nonce for a (tag, seed) pair. Unambiguous alphabet (no 0/1/i/l/o). */
export function nonceFrom(tag: string, seed: number): string {
  const rand = mulberry32(hashTag(tag, seed));
  const alphabet = "abcdefghjkmnpqrstuvwxyz23456789";
  let out = "";
  for (let i = 0; i < 8; i++) out += alphabet[Math.floor(rand() * alphabet.length)];
  return out;
}
