// Screen-reader announcer: one polite and one assertive live region per root, de-duplicated so the same message
// is not read twice within a short window, and cleared afterwards so stale text is not re-read on navigation.
export function createAnnouncer(root = globalThis.document.body) {
  const doc = root.ownerDocument || root, win = doc.defaultView;
  const style = 'position:absolute;width:1px;height:1px;margin:-1px;padding:0;overflow:hidden;clip:rect(0 0 0 0);white-space:nowrap;border:0';
  const make = politeness => { const el = doc.createElement('div'); el.setAttribute('aria-live', politeness); el.setAttribute('aria-atomic', 'true'); el.setAttribute('role', politeness === 'assertive' ? 'alert' : 'status'); el.style.cssText = style; el.dataset.cxAnnouncer = politeness; root.append(el); return el; };
  const regions = { polite: make('polite'), assertive: make('assertive') };
  const recent = new Map(), timers = new Set();
  let destroyed = false;
  function announce(message, { politeness = 'polite', dedupeMs = 1000 } = {}) {
    if (destroyed || !message) return;
    const now = win.performance.now(), key = politeness + message;
    if (now - (recent.get(key) ?? -Infinity) < dedupeMs) return;
    recent.set(key, now);
    const el = regions[politeness] || regions.polite;
    el.textContent = '';
    // A new text node in a later task is announced reliably across screen readers.
    const t1 = win.setTimeout(() => { timers.delete(t1); el.textContent = message; const t2 = win.setTimeout(() => { timers.delete(t2); if (el.textContent === message) el.textContent = ''; }, 7000); timers.add(t2); }, 60);
    timers.add(t1);
  }
  return {
    announce,
    get regions() { return regions; },
    destroy() { if (destroyed) return; destroyed = true; for (const t of timers) win.clearTimeout(t); timers.clear(); regions.polite.remove(); regions.assertive.remove(); },
  };
}
