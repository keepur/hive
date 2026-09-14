/**
 * Nearest-rank percentile (C = n*p/100, no interpolation).
 * The input may be unsorted; empty samples have no percentile.
 */
export function nearestRankPercentile(samples: readonly number[], p: number): number | null {
  if (samples.length === 0) return null;
  const sorted = [...samples].sort((a, b) => a - b);
  const index = Math.max(0, Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index]!;
}
