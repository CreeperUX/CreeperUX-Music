import { createMotion } from './motion-core.js';
import { createI18n, dirOf } from './i18n.js';
import { createFormatter } from './format.js';
import { createOverlayManager } from './overlay.js';
import { createAnnouncer } from './announce.js';
import { trackInputModality } from './interaction.js';

/**
 * createServices({ root, locale, messages, motion, reduced = 'system', tips = true, onStackChange }) — shared services for one application root:
 * i18n and formatting, motion, overlay manager, announcer (toasts come from getToaster(services)). Components receive
 * them as their third argument;
 * when omitted they use getServices(root), which lazily creates one shared set per document.
 */
export function createServices({ root = globalThis.document.body, locale, messages, motion, reduced = 'system', tips = true, onStackChange } = {}) {
  const doc = root.ownerDocument || root;
  const lang = locale || root.closest?.('[lang]')?.getAttribute('lang') || doc.documentElement.lang || 'en';
  const i18n = createI18n({ locale: lang, messages });
  let format = createFormatter(lang);
  const ownMotion = !motion;
  const m = motion || createMotion({ document: doc, reduced });
  const overlays = createOverlayManager({ root, onStackChange }); // onStackChange: embedding hosts follow the layers (G36)
  const announcer = createAnnouncer(doc.body);
  const modality = trackInputModality(root.nodeType === 1 ? root : doc.documentElement);
  const unsub = i18n.subscribe(loc => { format = createFormatter(loc); });
  let destroyed = false;
  return {
    root, motion: m, i18n, overlays, announcer, modality, tips, // tips: icon buttons and cut-off text show their text as a tooltip (G22)
    get format() { return format; },
    get dir() { return root.closest?.('[dir]')?.getAttribute('dir') || dirOf(i18n.locale); },
    t: (k, p) => i18n.t(k, p),
    announce: (msg, o) => announcer.announce(msg, o),
    /** An embedding host's back button (G36): closes the top layer as Escape would; false when nothing was open. */
    handleBack: () => overlays.handleBack(),
    get destroyed() { return destroyed; },
    destroy() { if (destroyed) return; destroyed = true; unsub(); overlays.destroy(); announcer.destroy(); modality.destroy(); if (ownMotion) m.destroy(); defaults.delete(doc); },
  };
}
const defaults = new WeakMap();
/** Shared default services for the document of `node` (created on first use). */
export function getServices(node = globalThis.document) {
  const doc = node.ownerDocument || node;
  let s = defaults.get(doc);
  if (!s || s.destroyed) { s = createServices({ root: doc.body }); defaults.set(doc, s); }
  return s;
}
