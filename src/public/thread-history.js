function turnKey(turn, index) {
  if (typeof turn?.id === "string" && turn.id) return `id:${turn.id}`;
  return `fallback:${turn?.startedAt ?? ""}:${turn?.completedAt ?? ""}:${index}`;
}

/**
 * Combines an older page with the turns already visible in the client.  Codex
 * pages are returned newest-first by the protocol, but this UI stores them in
 * chronological order for direct rendering.
 */
export function prependOlderTurns(existingTurns, olderTurns) {
  const result = [];
  const positions = new Map();

  for (const turn of [...(olderTurns ?? []), ...(existingTurns ?? [])]) {
    const key = turnKey(turn, result.length);
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, result.length);
      result.push(turn);
    } else {
      // A later copy is more complete when a page boundary overlaps.
      result[position] = turn;
    }
  }

  return result;
}

/**
 * Merges a fresh recent page into a locally expanded transcript.  Existing
 * older pages remain available, while matching recent turns are refreshed.
 */
export function mergeRecentTurns(existingTurns, recentTurns) {
  const result = [...(existingTurns ?? [])];
  const positions = new Map(result.map((turn, index) => [turnKey(turn, index), index]));

  for (const turn of recentTurns ?? []) {
    const key = turnKey(turn, result.length);
    const position = positions.get(key);
    if (position === undefined) {
      positions.set(key, result.length);
      result.push(turn);
    } else {
      result[position] = turn;
    }
  }

  return result;
}
