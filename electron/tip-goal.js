'use strict';
// Tip goal tracker: running total toward a goal, plus top tipper, for this show.
// Pure logic (no Electron/OBS) so it is unit-testable. main.js feeds it every tip.
const MAX_TIPPERS = 500;

function createTipGoal(initial = {}, onChange = () => {}) {
  const cfg = {
    title:   String(initial.title || 'Tip goal').slice(0, 60),
    target:  Math.floor(Number(initial.target)) >= 1 ? Math.floor(Number(initial.target)) : 1000,
    enabled: !!initial.enabled,
  };
  let total = 0;
  const tippers = new Map();

  function view() {
    let top = null;
    for (const [user, tokens] of tippers) if (!top || tokens > top.tokens) top = { user, tokens };
    return { ...cfg, total, top, percent: Math.min(100, Math.round((total / cfg.target) * 100)), reached: total >= cfg.target };
  }
  const emit = () => { try { onChange(view()); } catch {} };

  return {
    addTip(user, amount) {
      const t = Math.floor(Number(amount));
      if (!Number.isFinite(t) || t < 1) return false;
      const u = String(user || 'anon');
      if (tippers.has(u) || tippers.size < MAX_TIPPERS) tippers.set(u, (tippers.get(u) || 0) + t);
      total += t;
      emit();
      return true;
    },
    configure(c = {}) {
      if (c.title !== undefined) cfg.title = String(c.title).slice(0, 60) || 'Tip goal';
      const tg = Math.floor(Number(c.target));
      if (c.target !== undefined && tg >= 1) cfg.target = tg;
      if (c.enabled !== undefined) cfg.enabled = !!c.enabled;
      emit();
    },
    reset() { total = 0; tippers.clear(); emit(); },
    getConfig: () => ({ ...cfg }),
    getView: view,
    // Text shown in the OBS overlay, e.g. "Tip goal: 340/1000 (34%) — Top: bob 200"
    overlayText() {
      const v = view();
      const base = v.reached ? `${v.title}: GOAL REACHED! ${v.total} tokens` : `${v.title}: ${v.total}/${v.target} (${v.percent}%)`;
      return v.top ? `${base}\nTop tipper: ${v.top.user} (${v.top.tokens})` : base;
    },
  };
}

module.exports = { createTipGoal };
