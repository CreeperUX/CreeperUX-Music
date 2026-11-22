import { setup, fill, field, uid } from './base.js';

/**
 * createFileDrop(container, { label, description, accept: 'image/*,.pdf', maxSize (bytes), maxFiles, multiple = true,
 *   disabled, readOnly (the list without the drop zone or remove buttons), required,
 *   files: [{ id, name, size, status?: 'ready'|'uploading'|'done'|'error', progress?, error? }],
 *   onFiles({ accepted: File[], rejected: [{ file, reason }] }), onRemove({ file }) })
 * Host-owned list: the component validates and reports; the host adds accepted files to `files` and drives upload
 * status / progress. No transport is included (D23: upload manager is P1).
 */
export function createFileDrop(container, props = {}, services) {
  const c = setup(container, services, 'file');
  let p = { files: [], multiple: true, ...props };
  const input = c.h('input', { type: 'file', class: 'ui-visually-hidden', tabindex: '-1', 'aria-hidden': 'true' }); // the Browse button is the accessible control
  const browse = c.h('button', { type: 'button', class: 'ui-button' });
  const title = c.h('b'), hint = c.h('small');
  const zone = c.h('div', { class: 'ui-dropzone' }, c.icon('upload'), title, hint, browse, input);
  const list = c.h('ul', { class: 'ui-files' });
  const wrap = c.h('div', { class: 'ui-file-drop' }, zone, list);
  const f = field(c, wrap, { input: browse, label: p.label, description: p.description, required: p.required, optional: p.optional, hideLabel: p.hideLabel, labelFor: false });
  browse.setAttribute('aria-describedby', [f.ids.label].join(' '));
  c.own(f.el);
  const rows = new Map();
  const accepts = file => {
    if (!p.accept) return true;
    const name = file.name.toLowerCase(), type = (file.type || '').toLowerCase();
    return p.accept.split(',').map(s => s.trim().toLowerCase()).filter(Boolean).some(a => a.startsWith('.') ? name.endsWith(a) : a.endsWith('/*') ? type.startsWith(a.slice(0, -1)) : type === a);
  };
  function take(fileList) {
    if (p.disabled || p.readOnly) return;
    const accepted = [], rejected = [];
    const room = p.maxFiles ? Math.max(0, p.maxFiles - p.files.length) : Infinity;
    for (const file of [...fileList]) {
      if (!accepts(file)) rejected.push({ file, reason: c.s.t('file.wrongType') });
      else if (p.maxSize && file.size > p.maxSize) rejected.push({ file, reason: c.s.t('file.tooLarge', { size: c.s.format.bytes(p.maxSize) }) });
      else if (accepted.length >= room || (!p.multiple && accepted.length)) rejected.push({ file, reason: c.s.t('file.tooMany', { max: p.multiple ? p.maxFiles : 1 }) });
      else accepted.push(file);
    }
    f.setError(rejected.length ? `${rejected[0].file.name}: ${rejected[0].reason}${rejected.length > 1 ? ` (+${rejected.length - 1})` : ''}` : null);
    c.emit(f.el, 'files', { accepted, rejected }, p.onFiles);
    if (accepted.length) c.s.announce(c.s.format.list(accepted.map(x => x.name)));
  }
  function renderRow(file, li) {
    const meta = file.status === 'error' ? file.error || c.s.t('action.failed') : file.status === 'uploading' ? `${c.s.format.percent(file.progress ?? 0, 0)}` : c.s.format.bytes(file.size ?? 0);
    const rm = c.h('button', { type: 'button', class: 'ui-button', 'data-variant': 'ghost', 'data-icon-only': '', 'aria-label': c.s.t('file.remove', { name: file.name }) }, c.icon('close'));
    rm.addEventListener('click', () => c.emit(f.el, 'remove', { file }, p.onRemove));
    li.dataset.status = file.status || 'ready';
    fill(li, c.icon(/\.(png|jpe?g|gif|webp|avif|svg)$/i.test(file.name) ? 'image' : 'file'),
      c.h('div', { class: 'ui-file-body' }, c.h('span', { class: 'ui-file-name', title: file.name }, file.name), c.h('span', { class: 'ui-file-meta' }, meta),
        file.status === 'uploading' ? c.h('div', { class: 'ui-progress', role: 'progressbar', 'aria-valuenow': String(Math.round((file.progress ?? 0) * 100)), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-label': file.name }, c.h('i', { style: `transform:scaleX(${file.progress ?? 0})` })) : null),
      p.readOnly ? null : rm);
  }
  function renderList() {
    const keep = new Set();
    for (const file of p.files) {
      const id = file.id ?? file.name; keep.add(id);
      let li = rows.get(id);
      if (!li) { li = c.h('li', { class: 'ui-file' }); rows.set(id, li); list.append(li); renderRow(file, li); c.s.motion.animate(li, { h: li.offsetHeight, o: 1 }, { role: 'layout', from: { h: 0, o: 0 }, autoHeight: true }); }
      else renderRow(file, li);
    }
    for (const [id, li] of rows) if (!keep.has(id)) { rows.delete(id); c.s.motion.animate(li, { h: 0, o: 0 }, { role: 'layout', from: { h: li.offsetHeight } }).then(() => li.remove()); }
  }
  function render() {
    input.accept = p.accept ?? ''; input.multiple = !!p.multiple; input.disabled = !!p.disabled; browse.disabled = !!p.disabled;
    zone.toggleAttribute('data-disabled', !!p.disabled);
    zone.hidden = !!p.readOnly; // nothing can be added; the list is labelled by the field label instead
    if (p.readOnly) list.setAttribute('aria-labelledby', f.ids.label); else list.removeAttribute('aria-labelledby');
    title.textContent = c.s.t('file.drop');
    hint.textContent = p.accept || p.maxSize ? c.s.t('file.hint', { types: (p.acceptLabel ?? p.accept ?? '').toString(), size: p.maxSize ? c.s.format.bytes(p.maxSize) : '—' }) : '';
    browse.textContent = c.s.t('file.browse');
    f.setLabel(p.label); f.setDescription(p.description); f.setRequired(p.required, p.optional);
    if (p.error !== undefined) f.setError(p.error || null);
    renderList();
  }
  let depth = 0;
  c.on(browse, 'click', () => input.click());
  c.on(zone, 'click', e => { if (e.target === zone || e.target.closest('b, small, .ui-icon')) input.click(); });
  c.on(input, 'change', () => { take(input.files); input.value = ''; });
  c.on(zone, 'dragenter', e => { e.preventDefault(); if (++depth === 1 && !p.disabled) zone.dataset.over = ''; });
  c.on(zone, 'dragover', e => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = p.disabled ? 'none' : 'copy'; });
  c.on(zone, 'dragleave', () => { if (--depth <= 0) { depth = 0; delete zone.dataset.over; } });
  c.on(zone, 'drop', e => { e.preventDefault(); depth = 0; delete zone.dataset.over; if (e.dataTransfer?.files?.length) take(e.dataTransfer.files); });
  render(); container.append(f.el);
  return { root: f.el, input, update(n) { p = { ...p, ...n }; render(); }, addFiles: take, focus: () => (p.readOnly ? list.querySelector('button, a') : browse)?.focus(), destroy: () => c.destroy() };
}
