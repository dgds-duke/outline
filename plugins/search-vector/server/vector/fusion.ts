/** The RRF damping constant; 60 is the value from the original RRF paper. */
const K = 60;

/**
 * Reciprocal Rank Fusion of several ranked id lists into one deduped ranking.
 *
 * Each id's fused score is the sum, across the lists it appears in, of
 * 1 / (K + rank). Ids appearing high in multiple lists rank best.
 *
 * @param lists ranked id lists, each ordered best-first.
 * @returns a single deduped id list ordered by fused score, best first.
 */
export function reciprocalRankFusion(lists: string[][]): string[] {
  const score = new Map<string, number>();
  for (const list of lists) {
    list.forEach((id, index) => {
      score.set(id, (score.get(id) ?? 0) + 1 / (K + index + 1));
    });
  }
  return [...score.entries()].sort((a, b) => b[1] - a[1]).map(([id]) => id);
}
