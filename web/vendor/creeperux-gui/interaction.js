// Input modality and roving focus.
// Focus-visible policy: focus rings show for keyboard input only (CSS :focus-visible plus data-input="keyboard"
// on the root for components that need it); programmatically focused headings never show a ring; forced-colours
// mode always shows the system Highlight ring (foundation.css).

/** Tracks the last input modality on `root` as data-input="keyboard" | "pointer" | "touch". */
export function trackInputModality(root = globalThis.document.documentElement) {
  const doc = root.ownerDocument || root, abort = new AbortController();
  const set = v => { if (root.dataset.input !== v) root.dataset.input = v; };
  doc.addEventListener('keydown', e => { if (!e.metaKey && !e.ctrlKey && !e.altKey) set('keyboard'); }, { capture: true, signal: abort.signal });
  doc.addEventListener('pointerdown', e => set(e.pointerType === 'touch' ? 'touch' : 'pointer'), { capture: true, signal: abort.signal });
  return { get modality() { return root.dataset.input || 'pointer'; }, destroy() { abort.abort(); delete root.dataset.input; } };
}

/**
 * Roving tabindex (APG): one tab stop inside `container`; arrow keys move between items.
 * createRovingFocus(container, { items: () => Element[], orientation: 'horizontal'|'vertical'|'both', loop = true,
 *   onMove(item, index, event), typeahead = false, getLabel })
 */
export function createRovingFocus(container, { items, orientation = 'horizontal', loop = true, onMove, typeahead = false, getLabel = el => el.textContent.trim() } = {}) {
  const doc = container.ownerDocument, abort = new AbortController();
  const list = () => items().filter(el => !el.hidden && !el.closest('[hidden]') && el.getAttribute('aria-disabled') !== 'true' && !el.disabled);
  let current = null, buffer = '', bufferTimer = 0;
  function setCurrent(el, focus = false, event) {
    for (const it of items()) it.tabIndex = it === el ? 0 : -1;
    current = el;
    if (focus && el) { el.focus(); onMove?.(el, list().indexOf(el), event); }
  }
  function sync() { const all = list(); if (!all.includes(current)) setCurrent(all.find(el => el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-current')) || all[0] || null); else setCurrent(current); }
  // In a text field the arrows and Home / End edit the text; the field is left only from its first or last character (G31).
  const textField = el => el?.matches?.('input:not([type="checkbox"]):not([type="radio"]):not([type="button"]):not([type="submit"]), textarea');
  const atEdge = (el, dir) => { try { const n = el.value.length; return dir < 0 ? el.selectionStart === 0 && el.selectionEnd === 0 : el.selectionStart === n && el.selectionEnd === n; } catch { return true; } };
  container.addEventListener('keydown', e => {
    const all = list(); if (!all.length) return;
    const rtl = doc.defaultView.getComputedStyle(container).direction === 'rtl';
    const i = Math.max(0, all.indexOf(doc.activeElement));
    const next = { ArrowRight: rtl ? -1 : 1, ArrowLeft: rtl ? 1 : -1, ArrowDown: 1, ArrowUp: -1 }[e.key];
    if (textField(e.target) && (e.key === 'Home' || e.key === 'End' || (next != null && !atEdge(e.target, next)))) return;
    const axisOk = e.key.startsWith('Arrow') && (orientation === 'both' || (orientation === 'horizontal') === (e.key === 'ArrowLeft' || e.key === 'ArrowRight'));
    let target = null;
    if (next != null && axisOk) { let n = i + next; if (loop) n = (n + all.length) % all.length; else n = Math.max(0, Math.min(all.length - 1, n)); target = all[n]; }
    else if (e.key === 'Home') target = all[0];
    else if (e.key === 'End') target = all[all.length - 1];
    else if (typeahead && e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      buffer += e.key.toLowerCase(); clearTimeout(bufferTimer); bufferTimer = setTimeout(() => { buffer = ''; }, 500);
      const order = [...all.slice(i + 1), ...all.slice(0, i + 1)];
      target = order.find(el => getLabel(el).toLowerCase().startsWith(buffer)) || null;
    }
    if (target) { e.preventDefault(); setCurrent(target, true, e); }
  }, { signal: abort.signal });
  container.addEventListener('focusin', e => { const all = list(); if (all.includes(e.target)) setCurrent(e.target); }, { signal: abort.signal });
  sync();
  return { sync, focus: el => setCurrent(el || current, true), get current() { return current; }, destroy() { abort.abort(); clearTimeout(bufferTimer); } };
}
