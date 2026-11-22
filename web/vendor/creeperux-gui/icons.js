// Icon registry: 24 px grid, 1.6 px stroke, round joins; size follows density (--cx-icon). Directional icons are
// mirrored in RTL. Icons are decorative (aria-hidden) unless a label is given. Apps add icons with registerIcons().
const PATHS = {
  check: '<path d="M5 12.5l4.5 4.5L19 7"/>', close: '<path d="M6 6l12 12M18 6L6 18"/>', plus: '<path d="M12 5v14M5 12h14"/>', minus: '<path d="M5 12h14"/>',
  'chevron-down': '<path d="M6 9l6 6 6-6"/>', 'chevron-up': '<path d="M6 15l6-6 6 6"/>', 'chevron-right': '<path d="M9 6l6 6-6 6"/>', 'chevron-left': '<path d="M15 6l-6 6 6 6"/>',
  'arrow-left': '<path d="M19 12H5M11 6l-6 6 6 6"/>', 'arrow-right': '<path d="M5 12h14M13 6l6 6-6 6"/>', 'arrow-up': '<path d="M12 19V5M6 11l6-6 6 6"/>', 'arrow-down': '<path d="M12 5v14M6 13l6 6 6-6"/>',
  search: '<circle cx="11" cy="11" r="6"/><path d="M20 20l-4.5-4.5"/>', more: '<circle cx="5.5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="18.5" cy="12" r="1"/>',
  'more-vertical': '<circle cx="12" cy="5.5" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="12" cy="18.5" r="1"/>', menu: '<path d="M4 7h16M4 12h16M4 17h16"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15" rx="2"/><path d="M3.5 10h17M8 3v4M16 3v4"/>', clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  upload: '<path d="M12 16V4M7 9l5-5 5 5M4 16v3a1 1 0 0 0 1 1h14a1 1 0 0 0 1-1v-3"/>', download: '<path d="M12 4v12M7 11l5 5 5-5M4 20h16"/>',
  file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>', image: '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="9" cy="10" r="2"/><path d="M21 16l-5-5-9 9"/>',
  alert: '<path d="M12 4l9 16H3z"/><path d="M12 10v4M12 17.5v.01"/>', info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6M12 7.5v.01"/>', 'check-circle': '<circle cx="12" cy="12" r="9"/><path d="M8 12.5l3 3 5-6"/>', error: '<circle cx="12" cy="12" r="9"/><path d="M9 9l6 6M15 9l-6 6"/>',
  edit: '<path d="M4 20h4L19 9l-4-4L4 16z"/>', trash: '<path d="M4 7h16M9 7V4h6v3M6 7l1 13h10l1-13"/>', copy: '<rect x="8" y="8" width="12" height="12" rx="2"/><path d="M16 8V5a1 1 0 0 0-1-1H5a1 1 0 0 0-1 1v10a1 1 0 0 0 1 1h3"/>',
  filter: '<path d="M4 5h16l-6 8v5l-4 2v-7z"/>', sort: '<path d="M8 5v14M5 16l3 3 3-3M16 19V5M13 8l3-3 3 3"/>', settings: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  refresh: '<path d="M20 11a8 8 0 1 0-2.3 5.7M20 5v6h-6"/>', external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>', eye: '<path d="M2.5 12S6 5.5 12 5.5 21.5 12 21.5 12 18 18.5 12 18.5 2.5 12 2.5 12z"/><circle cx="12" cy="12" r="3"/>',
  'eye-off': '<path d="M3 3l18 18M10.6 6.1A9.6 9.6 0 0 1 12 6c6 0 9.5 6 9.5 6a17 17 0 0 1-3.3 4M6.6 7.6C4 9.4 2.5 12 2.5 12S6 18 12 18a9 9 0 0 0 4-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/>',
  user: '<circle cx="12" cy="8" r="3.5"/><path d="M5 20a7 7 0 0 1 14 0"/>', home: '<path d="M4 11l8-7 8 7v9h-5v-6H9v6H4z"/>', bell: '<path d="M6 16V11a6 6 0 0 1 12 0v5l2 2H4zM10 20a2 2 0 0 0 4 0"/>',
  lock: '<rect x="5" y="10.5" width="14" height="9.5" rx="2"/><path d="M8 10.5V8a4 4 0 0 1 8 0v2.5"/>', block: '<circle cx="12" cy="12" r="8.5"/><path d="M6 6l12 12"/>',
  offline: '<path d="M3 3l18 18"/><path d="M17.5 18H7a4.3 4.3 0 0 1-1.2-8.4M9 6.3A6 6 0 0 1 17.5 10a4 4 0 0 1 2.6 6.3"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7L12 6.3M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>', grip: '<circle cx="9" cy="7" r="1"/><circle cx="15" cy="7" r="1"/><circle cx="9" cy="12" r="1"/><circle cx="15" cy="12" r="1"/><circle cx="9" cy="17" r="1"/><circle cx="15" cy="17" r="1"/>',
};
const MIRRORED = new Set(['chevron-right', 'chevron-left', 'arrow-left', 'arrow-right', 'external']);
const registry = new Map(Object.entries(PATHS).map(([k, v]) => [k, { svg: v, mirror: MIRRORED.has(k) }]));

/** registerIcons({ name: '<svg …>' }, { mirror: [names] }) — adds icons to the registry; mirrored icons flip in right-to-left text. */
export function registerIcons(map, { mirror = [] } = {}) { for (const [k, v] of Object.entries(map)) registry.set(k, { svg: v, mirror: mirror.includes(k) }); }
export const iconNames = () => [...registry.keys()];

/** icon(name, { label, size, doc }) → SVGElement. Unknown names render an empty, still-sized box. */
// Parsed icons are cached per document and name and cloned on use (parsing SVG markup for every menu item was a
// measurable part of opening a menu).
const templates = new WeakMap();
function template(doc, name) {
  let byName = templates.get(doc);
  if (!byName) templates.set(doc, (byName = new Map()));
  let t = byName.get(name);
  const def = registry.get(name);
  if (!t || t._def !== def) {
    t = doc.createElementNS('http://www.w3.org/2000/svg', 'svg');
    t.setAttribute('class', 'ui-icon'); t.setAttribute('viewBox', '0 0 24 24');
    if (def?.mirror) t.dataset.mirror = '';
    t.innerHTML = def?.svg || '';
    t._def = def;
    byName.set(name, t);
  }
  return t;
}
/** icon(name, { label, size }) — an inline SVG icon; decorative unless `label` is given (then role=img with that name). */
export function icon(name, { label, size, doc = globalThis.document } = {}) {
  const s = template(doc, name).cloneNode(true);
  if (size) { s.style.width = s.style.height = typeof size === 'number' ? `${size}px` : size; }
  if (label) { s.setAttribute('role', 'img'); s.setAttribute('aria-label', label); } else { s.setAttribute('aria-hidden', 'true'); s.setAttribute('focusable', 'false'); }
  return s;
}
