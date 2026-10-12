// Tracks the latest viewer count per platform so the dashboard can show a
// total plus a per-platform breakdown (and one platform's number never
// overwrites the combined total).
function createViewerCounts(emit) {
  const counts = {};
  function snapshot() {
    const total = Object.values(counts).reduce((a, b) => a + b, 0);
    return { total, platforms: { ...counts } };
  }
  return {
    set(platform, n) {
      n = Number(n);
      if (!Number.isFinite(n) || n < 0) return;
      if (counts[platform] === n) return;
      counts[platform] = n;
      emit(snapshot());
    },
    clear() { for (const k of Object.keys(counts)) delete counts[k]; },
    snapshot,
  };
}
module.exports = { createViewerCounts };
