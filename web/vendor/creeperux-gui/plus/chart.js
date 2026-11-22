import { setup, fill, uid, createTable, createEmptyState } from '../ui/index.js';
import { plusStrings } from './strings.js';

const NS = 'http://www.w3.org/2000/svg';
const TONES = ['accent', 'info', 'good', 'warn', 'neutral', 'bad'];
const SHAPES = ['circle', 'square', 'triangle', 'diamond']; // scatter series differ by shape as well as colour
function niceStep(range, ticks = 4) {
  const raw = range / ticks || 1, mag = 10 ** Math.floor(Math.log10(raw)), f = raw / mag;
  return (f <= 1 ? 1 : f <= 2 ? 2 : f <= 2.5 ? 2.5 : f <= 5 ? 5 : 10) * mag;
}
const niceTicks = (lo, hi, count) => {
  const step = niceStep(hi - lo, count), a = Math.floor(lo / step) * step, b = Math.ceil(hi / step) * step || step, out = [];
  for (let v = a; v <= b + step / 2; v += step) out.push(+v.toFixed(10));
  return out;
};

const SEC = 1e3, MIN = 60 * SEC, HOUR = 60 * MIN, DAY = 24 * HOUR;
// [step, unit, count]; month and year steps follow the calendar, days start at local midnight
const TIME_STEPS = [[SEC, 's', 1], [5 * SEC, 's', 5], [15 * SEC, 's', 15], [30 * SEC, 's', 30], [MIN, 'm', 1], [5 * MIN, 'm', 5], [15 * MIN, 'm', 15],
  [30 * MIN, 'm', 30], [HOUR, 'h', 1], [3 * HOUR, 'h', 3], [6 * HOUR, 'h', 6], [12 * HOUR, 'h', 12], [DAY, 'd', 1], [2 * DAY, 'd', 2], [7 * DAY, 'd', 7], [14 * DAY, 'd', 14],
  [30 * DAY, 'mo', 1], [91 * DAY, 'mo', 3], [182 * DAY, 'mo', 6], [365 * DAY, 'y', 1]];
/** Local-time ticks between two timestamps, at most about `max` of them: { ticks, unit: 's'|'m'|'h'|'d'|'mo'|'y' }. */
export function timeTicks(a, b, max = 6) {
  const span = Math.max(1, b - a);
  const [ms, unit, n] = TIME_STEPS.find(s => span / s[0] <= max) || [0, 'y', Math.ceil(span / (365 * DAY) / max)];
  const ticks = [];
  if (unit === 'mo' || unit === 'y') {
    const months = unit === 'y' ? 12 * n : n, d = new Date(a), at = k => new Date(Math.floor(k / 12), k % 12, 1).getTime();
    let k = d.getFullYear() * 12 + d.getMonth();
    if (at(k) < a) k++;
    for (k = Math.ceil(k / months) * months; at(k) <= b; k += months) ticks.push(at(k));
  } else if (unit === 'd') {
    const d = new Date(a); d.setHours(0, 0, 0, 0);
    if (d.getTime() < a) d.setDate(d.getDate() + 1);
    for (; d.getTime() <= b; d.setDate(d.getDate() + n)) ticks.push(d.getTime());
  } else {
    const off = new Date(a).getTimezoneOffset() * MIN; // align to the local clock
    for (let t = Math.ceil((a + off) / ms) * ms - off; t <= b; t += ms) ticks.push(t);
  }
  return { ticks, unit };
}
const lowerBound = (xs, v) => { let lo = 0, hi = xs.length; while (lo < hi) { const m = (lo + hi) >> 1; if (xs[m] < v) lo = m + 1; else hi = m; } return lo; };
const finite = v => v != null && Number.isFinite(v);

/**
 * createChart(container, { type: 'line'|'area'|'bar'|'scatter'|'donut', series: [{ id, label, values, points, band,
 *   tone, dashed, as: 'line'|'area'|'bar', hidden }], labels, x, xType: 'category'|'linear'|'time', label, description,
 *   height = 220, stacked, min, max, yFormat(v), xFormat(v), legend = true, toggle = true, maxGap, zoom, range,
 *   onRangeChange({ range, reason }), selected, onSelect(e), onSeriesToggle({ id, hidden }), state, stateMessage,
 *   updatedAt, onRetry }, services)
 * Responsive SVG chart. Pointer and arrow keys inspect a point (the readout is announced politely); "Data table" shows
 * the same numbers as a table. Series differ by dash pattern or marker shape as well as colour. Values never animate
 * (D13). The plot is laid out left to right in every direction.
 * Since 2.4.0 (G40, G41):
 * - x axes: `labels` (categories, the default), or `x` with `xType: 'linear'` (numbers) or `'time'` (timestamps or
 *   dates; local-time ticks), ascending. A line breaks at a null value, and with `maxGap` where neighbouring x values
 *   are further apart. A series' `band: { lo, hi }` draws its min / max envelope behind the line.
 * - long series are decimated to the plot's width (each pixel keeps its first, lowest, highest and last value), so the
 *   shape and the extremes survive; inspection and the data table still use every point.
 * - `zoom`: drag across a numeric or time plot to zoom to that range, + and − zoom around the inspected point, 0 or
 *   "Reset zoom" resets; `range` sets it, and `onRangeChange` reports it.
 * - `type: 'scatter'` takes each series' `points` ([x, y] or { x, y }); `type: 'donut'` draws the first series'
 *   values as slices named by `labels`, with the total in the middle.
 * - stacked bars stack positive values up and negative values down, each from zero.
 * - the legend's entries toggle their series (or slices), keeping at least one shown (`onSeriesToggle`); `toggle:
 *   false` makes it a plain key.
 * - a click, or Enter on the inspected point, selects it (`onSelect`, a `selected` mark; `selected` sets it).
 * - `state`: 'loading' (dims the drawing, or says Loading… when there is none), 'error' (in place, with Retry),
 *   'stale' (a notice above, with `updatedAt` and Retry) or 'empty'; a chart without values shows the empty state.
 */
export function createChart(container, props = {}, services) {
  const c = setup(container, services, 'chart'); plusStrings(c.s);
  let p = { type: 'line', series: [], labels: [], height: 220, legend: true, ...props };
  const hintId = uid('chk'), clipId = uid('chc');
  const svg = c.doc.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'ui-chart-svg'); svg.setAttribute('role', 'img');
  const tip = c.h('div', { class: 'ui-chart-tip', hidden: true, 'aria-hidden': 'true' });
  const brush = c.h('div', { class: 'ui-chart-brush', hidden: true, 'aria-hidden': 'true' });
  const plot = c.h('div', { class: 'ui-chart-plot', tabindex: '0', role: 'group', dir: 'ltr', 'aria-describedby': hintId }, svg, tip, brush);
  const legend = c.h('ul', { class: 'ui-chart-legend' });
  const resetBtn = c.h('button', { type: 'button', class: 'ui-button ui-chart-reset', 'data-variant': 'ghost', hidden: true }, c.icon('refresh'), c.h('span'));
  const dataBtn = c.h('button', { type: 'button', class: 'ui-button ui-chart-data-btn', 'data-variant': 'ghost', 'aria-expanded': 'false' }, c.icon('menu'), c.h('span'));
  const stateBox = c.h('div', { class: 'ui-chart-state' });
  const dataBox = c.h('div', { class: 'ui-chart-data', hidden: true });
  const hint = c.h('span', { id: hintId, class: 'ui-visually-hidden' });
  const el = c.own(c.h('figure', { class: 'ui-chart' }, c.h('div', { class: 'ui-chart-head' }, legend, resetBtn, dataBtn), stateBox, plot, hint, dataBox));
  let width = 0, frame = 0, idx = -1, sel = p.selected ?? -1, geom = null, table = null, tableKey = '', stateHandle = null, stateKind = null;
  let range = p.range || null, drag = null;
  let hidden = new Set(p.series.filter(s => s.hidden).map(s => s.id)), hiddenSlices = new Set();
  const fmt = v => (v == null || Number.isNaN(v) ? '—' : p.yFormat ? p.yFormat(v) : c.s.format.number(v, { maximumFractionDigits: 2 }));
  const tone = (s, i) => s.tone || TONES[i % TONES.length];
  const svgEl = (tag, attrs) => { const e = c.doc.createElementNS(NS, tag); for (const [k, v] of Object.entries(attrs)) if (v != null) e.setAttribute(k, String(v)); return e; };
  const kind = () => (p.type === 'donut' ? 'donut' : p.type === 'scatter' ? 'scatter' : 'xy');
  const xKind = () => p.xType || (p.x || p.type === 'scatter' ? 'linear' : 'category');
  const shown = () => p.series.filter(s => !hidden.has(s.id));
  const pointOf = q => (Array.isArray(q) ? { x: +q[0], y: q[1] } : { x: +q.x, y: q.y });
  function timeLabel(t, unit) {
    const f = c.s.format, d = new Date(t), midnight = !d.getHours() && !d.getMinutes() && !d.getSeconds();
    if (unit === 'y') return f.date(t, { year: 'numeric' });
    if (unit === 'mo') return f.date(t, d.getMonth() ? { month: 'short' } : { month: 'short', year: 'numeric' });
    if (unit === 'd' || midnight) return f.date(t, { month: 'short', day: 'numeric' });
    return f.time(t, unit === 's' ? { hour: '2-digit', minute: '2-digit', second: '2-digit' } : { hour: '2-digit', minute: '2-digit' });
  }
  // an x value as the tick shows it (unit) or in full (readouts and the table)
  const xText = (v, unit) => (p.xFormat ? p.xFormat(v) : xKind() === 'time' ? (unit ? timeLabel(v, unit) : c.s.format.dateTime(v)) : c.s.format.number(v, { maximumFractionDigits: 6 }));
  let xsKey = null, xsMemo = [];
  const xs = () => { // x positions, kept while the data is the same
    const src = xKind() === 'category' ? p.labels : p.x || [];
    if (xsKey?.[0] !== src || xsKey[1] !== xKind()) { xsKey = [src, xKind()]; xsMemo = xKind() === 'category' ? src.map((_, i) => i) : src.map(v => +v); }
    return xsMemo;
  };
  const labelAt = i => (xKind() === 'category' ? p.labels[i] : xText(xs()[i]));
  const hasData = () => (kind() === 'donut' ? (p.series[0]?.values || []).some(finite) : kind() === 'scatter' ? p.series.some(s => (s.points || []).length) : p.series.some(s => s.values?.some(finite)));

  function render() {
    frame = 0;
    width = plot.clientWidth || 600;
    if (p.description) { svg.setAttribute('role', 'img'); svg.setAttribute('aria-label', p.description); svg.removeAttribute('aria-hidden'); } else { svg.removeAttribute('role'); svg.removeAttribute('aria-label'); svg.setAttribute('aria-hidden', 'true'); }
    plot.setAttribute('aria-label', p.label || '');
    const zoomable = !!p.zoom && kind() === 'xy' && xKind() !== 'category';
    hint.textContent = [c.s.t(p.onSelect ? 'chart.keysSelect' : 'chart.keys'), zoomable ? c.s.t('chart.keysZoom') : ''].filter(Boolean).join('. ');
    renderState();
    resetBtn.hidden = !(zoomable && range);
    resetBtn.lastChild.textContent = c.s.t('chart.reset');
    if (plot.hidden) geom = null;
    else {
      if (kind() === 'donut') renderDonut(); else if (kind() === 'scatter') renderScatter(); else renderXY(zoomable);
    }
    renderLegend();
    dataBtn.hidden = !hasData();
    dataBtn.lastChild.textContent = c.s.t(dataBox.hidden ? 'chart.data' : 'chart.hideData');
    if (idx >= 0 && geom) show(idx, false); else hide();
    if (table) { const key = tableSignature(); if (key !== tableKey) { table.destroy(); table = null; dataBox.replaceChildren(); if (!dataBox.hidden) openTable(); } else table.update(tableProps()); }
  }
  // data states: loading, error and empty take the drawing's place; stale sits above it
  function renderState() {
    const empty = !hasData();
    const st = p.state === 'error' ? 'error' : p.state === 'loading' ? (empty ? 'loading' : 'refreshing') : p.state === 'stale' && !empty ? 'stale' : empty || p.state === 'empty' ? 'empty' : null;
    el.toggleAttribute('aria-busy', st === 'loading' || st === 'refreshing');
    el.toggleAttribute('data-refreshing', st === 'refreshing');
    plot.hidden = st === 'loading' || st === 'error' || st === 'empty';
    if (st === stateKind && stateHandle) { stateHandle.update?.(stateProps(st)); return; }
    stateHandle?.destroy?.(); stateHandle = null; stateBox.replaceChildren(); stateKind = st;
    if (st === 'loading') { stateBox.append(c.h('p', { class: 'ui-chart-loading', role: 'status' }, c.h('span', { class: 'ui-spinner', 'aria-hidden': 'true' }), c.s.t('loading'))); return; }
    if (st && st !== 'refreshing') stateHandle = createEmptyState(stateBox, stateProps(st), c.s);
  }
  const stateProps = st => ({ kind: st, message: p.stateMessage, title: st === 'empty' ? c.s.t('chart.empty') : undefined, updatedAt: p.updatedAt, onRetry: p.onRetry });

  function axisY(g, m, W, Y, ticks) {
    for (const t of ticks) { g.push(svgEl('line', { class: 'ui-chart-grid', x1: m.l, x2: W - m.r, y1: Y(t), y2: Y(t) })); const tx = svgEl('text', { class: 'ui-chart-ytick', x: m.l - 6, y: Y(t) + 4, 'text-anchor': 'end' }); tx.textContent = fmt(t); g.push(tx); }
  }
  // x ticks for a numeric or time axis, thinned to the width
  function axisX(g, H, pw, d0, d1, X) {
    const count = Math.max(3, Math.floor(pw / 80));
    const { ticks, unit } = xKind() === 'time' ? timeTicks(d0, d1, count) : { ticks: niceTicks(d0, d1, count).filter(v => v >= d0 - 1e-9 && v <= d1 + 1e-9), unit: null };
    for (const v of ticks) { const tx = svgEl('text', { class: 'ui-chart-xtick', x: X(v), y: H - 6, 'text-anchor': 'middle' }); tx.textContent = xText(v, unit || undefined); g.push(tx); }
  }
  function frameOf(H, ticks) {
    const labelW = Math.max(...ticks.map(t => fmt(t).length)) * 6.6 + 10;
    const m = { l: labelW, r: 12, t: 10, b: 24 }, W = Math.max(120, width);
    return { m, W, pw: W - m.l - m.r, ph: H - m.t - m.b };
  }
  // per pixel column: the first, lowest, highest and last point (indices in order)
  function decimate(seg, val, X) {
    if (seg.length <= 4 * Math.max(60, width)) return seg;
    const out = []; let col = null, first, last, lo, hi;
    const flush = () => { if (col != null) for (const i of [...new Set([first, lo, hi, last])].sort((a, b) => a - b)) out.push(i); };
    for (const i of seg) {
      const cx = Math.floor(X(i)), v = val(i);
      if (cx !== col) { flush(); col = cx; first = last = lo = hi = i; continue; }
      last = i; if (v < val(lo)) lo = i; if (v > val(hi)) hi = i;
    }
    flush();
    return out;
  }

  function renderXY(zoomable) {
    const H = p.height, ser = shown(), all = xs(), n = all.length, cat = xKind() === 'category';
    const asOf = s => s.as || (p.type === 'scatter' || p.type === 'donut' ? 'line' : p.type);
    const bars = ser.filter(s => asOf(s) === 'bar'), lines = ser.filter(s => asOf(s) !== 'bar');
    // the window: every index, or those inside the zoom range plus one on each side, so lines run to the edge
    let full = cat ? [0, Math.max(0, n - 1)] : [Infinity, -Infinity];
    if (!cat) for (const v of all) { if (v < full[0]) full[0] = v; if (v > full[1]) full[1] = v; }
    if (!Number.isFinite(full[0])) full = [0, 1];
    const win = zoomable && range ? [Math.max(full[0], range[0]), Math.min(full[1], range[1])] : null;
    const i0 = win ? Math.max(0, lowerBound(all, win[0]) - 1) : 0, i1 = win ? Math.min(n - 1, lowerBound(all, win[1] + 1e-9)) : n - 1;
    // y extent over the window: stacks go up from zero for positive values and down for negative ones
    let lo = Infinity, hi = -Infinity;
    const take = v => { if (finite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; } };
    for (let i = i0; i <= i1; i++) {
      if (win && (all[i] < win[0] || all[i] > win[1])) continue;
      if (p.stacked && bars.length) { let up = 0, down = 0; for (const s of bars) { const v = s.values[i]; if (finite(v)) { if (v >= 0) up += v; else down += v; } } take(up); take(down); }
      for (const s of p.stacked ? lines : ser) { take(s.values[i]); if (s.band) { take(s.band.lo?.[i]); take(s.band.hi?.[i]); } }
    }
    if (!Number.isFinite(lo)) { lo = 0; hi = 1; }
    if (bars.length || lo >= 0) lo = Math.min(0, lo);
    lo = p.min ?? lo; hi = p.max ?? hi;
    const ticks = niceTicks(lo, hi, 4), y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const { m, W, pw, ph } = frameOf(H, ticks);
    const Y = v => m.t + ph - ((v - y0) / (y1 - y0 || 1)) * ph;
    let X, band, gx = {};
    if (cat) {
      band = pw / Math.max(1, n);
      X = i => (bars.length ? m.l + band * (i + 0.5) : m.l + (n > 1 ? (pw * i) / (n - 1) : pw / 2));
    } else {
      let [d0, d1] = win || full;
      if (bars.length) { let gap = Infinity; for (let i = Math.max(1, i0); i <= i1; i++) gap = Math.min(gap, all[i] - all[i - 1]); if (!Number.isFinite(gap) || gap <= 0) gap = (d1 - d0) || 1; d0 -= gap / 2; d1 += gap / 2; band = (pw * gap) / (d1 - d0 || 1); }
      if (d1 === d0) { d0 -= 1; d1 += 1; }
      const sx = v => m.l + ((v - d0) / (d1 - d0)) * pw;
      X = i => sx(all[i]);
      gx = { sx, d0, d1 };
    }
    const g = [];
    axisY(g, m, W, Y, ticks);
    if (cat) {
      const longest = Math.max(1, ...p.labels.map(l => String(l).length)), every = Math.max(1, Math.ceil(n / Math.max(1, Math.floor(pw / (longest * 6.6 + 14)))));
      p.labels.forEach((l, i) => { if (i % every) return; const tx = svgEl('text', { class: 'ui-chart-xtick', x: X(i), y: H - 6, 'text-anchor': 'middle' }); tx.textContent = l; g.push(tx); });
    } else axisX(g, H, pw, gx.d0, gx.d1, gx.sx);
    const clip = svgEl('clipPath', { id: clipId }); clip.append(svgEl('rect', { x: m.l, y: 0, width: pw, height: H }));
    const body = svgEl('g', { 'clip-path': `url(#${clipId})` });
    const inWin = i => !win || (all[i] >= win[0] && all[i] <= win[1]);
    // bars
    const bw = (band || pw) * 0.7;
    if (bars.length) for (let i = i0; i <= i1; i++) {
      if (!inWin(i)) continue;
      let up = 0, down = 0;
      bars.forEach((s, k) => {
        const v = s.values[i]; if (!finite(v)) return;
        let x, w, ya, yb;
        if (p.stacked) { x = X(i) - bw / 2; w = bw; if (v >= 0) { ya = Y(up + v); yb = Y(up); up += v; } else { ya = Y(down); yb = Y(down + v); down += v; } }
        else { w = bw / bars.length; x = X(i) - bw / 2 + k * w; ya = Y(Math.max(v, 0)); yb = Y(Math.min(v, 0)); }
        body.append(svgEl('rect', { class: 'ui-chart-bar', 'data-tone': tone(s, p.series.indexOf(s)), x: x + 0.5, y: Math.min(ya, yb), width: Math.max(1, w - 1), height: Math.max(1, Math.abs(yb - ya)) }));
      });
    }
    // lines, areas and bands: each breaks where its own values are missing and, with maxGap, across wider x gaps
    const base = Y(Math.max(y0, 0));
    const segments = ok => {
      const segs = []; let cur = [];
      for (let i = i0; i <= i1; i++) {
        const gap = !cat && p.maxGap != null && cur.length && all[i] - all[cur[cur.length - 1]] > p.maxGap;
        if (!ok(i) || gap) { if (cur.length) segs.push(cur); cur = ok(i) ? [i] : []; } else cur.push(i);
      }
      if (cur.length) segs.push(cur);
      return segs;
    };
    for (const s of lines) {
      const k = p.series.indexOf(s);
      if (s.band) for (const b of segments(i => finite(s.band.lo?.[i]) && finite(s.band.hi?.[i]))) {
        const top = decimate(b, i => s.band.hi[i], X), bottom = decimate(b, i => -s.band.lo[i], X);
        if (top.length > 1) body.append(svgEl('polygon', { class: 'ui-chart-band', 'data-tone': tone(s, k), points: [...top.map(i => `${X(i).toFixed(1)},${Y(s.band.hi[i]).toFixed(1)}`), ...bottom.reverse().map(i => `${X(i).toFixed(1)},${Y(s.band.lo[i]).toFixed(1)}`)].join(' ') }));
      }
      for (const seg of segments(i => finite(s.values[i]))) {
        const pts = decimate(seg, i => s.values[i], X).map(i => `${X(i).toFixed(1)},${Y(s.values[i]).toFixed(1)}`);
        if (asOf(s) === 'area') body.append(svgEl('polygon', { class: 'ui-chart-area', 'data-tone': tone(s, k), points: `${pts[0].split(',')[0]},${base} ${pts.join(' ')} ${pts[pts.length - 1].split(',')[0]},${base}` }));
        body.append(svgEl('polyline', { class: 'ui-chart-line', 'data-tone': tone(s, k), 'data-dashed': s.dashed ? '' : null, points: pts.join(' ') }));
      }
    }
    const selMark = svgEl('g', { class: 'ui-chart-selmark' });
    const cross = svgEl('line', { class: 'ui-chart-cross', x1: 0, x2: 0, y1: m.t, y2: m.t + ph, visibility: 'hidden' });
    const dots = svgEl('g', { class: 'ui-chart-dots' });
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.replaceChildren(clip, ...g, body, selMark, cross, dots);
    const visible = []; for (let i = i0; i <= i1; i++) if (inWin(i)) visible.push(i);
    geom = { kind: 'xy', visible, X, Y, m, ph, W, cross, dots, selMark, lines, cat, sx: gx.sx || null, d0: gx.d0, d1: gx.d1 };
    if (sel >= 0 && sel < n && inWin(sel)) {
      const x = X(sel);
      selMark.append(svgEl('line', { class: 'ui-chart-sel', x1: x, x2: x, y1: m.t, y2: m.t + ph }));
      for (const s of lines) if (finite(s.values[sel])) selMark.append(svgEl('circle', { class: 'ui-chart-seldot', 'data-tone': tone(s, p.series.indexOf(s)), cx: x, cy: Y(s.values[sel]), r: 5 }));
    }
  }

  function scatterPoints() {
    const out = [];
    shown().forEach(s => { const k = p.series.indexOf(s); (s.points || []).forEach((q, j) => { const pt = pointOf(q); if (Number.isFinite(pt.x) && finite(pt.y)) out.push({ s, k, j, x: pt.x, y: pt.y }); }); });
    return out.sort((a, b) => a.x - b.x || a.y - b.y);
  }
  function marker(shape, x, y, r, attrs) {
    if (shape === 'square') return svgEl('rect', { ...attrs, x: x - r, y: y - r, width: 2 * r, height: 2 * r });
    if (shape === 'triangle') return svgEl('path', { ...attrs, d: `M${x},${y - r * 1.2}L${x + r * 1.1},${y + r * 0.8}L${x - r * 1.1},${y + r * 0.8}Z` });
    if (shape === 'diamond') return svgEl('path', { ...attrs, d: `M${x},${y - r * 1.3}L${x + r * 1.3},${y}L${x},${y + r * 1.3}L${x - r * 1.3},${y}Z` });
    return svgEl('circle', { ...attrs, cx: x, cy: y, r });
  }
  function renderScatter() {
    const H = p.height, pts = scatterPoints();
    let xl = Infinity, xh = -Infinity, yl = Infinity, yh = -Infinity;
    for (const q of pts) { xl = Math.min(xl, q.x); xh = Math.max(xh, q.x); yl = Math.min(yl, q.y); yh = Math.max(yh, q.y); }
    if (!pts.length) { xl = 0; xh = 1; yl = 0; yh = 1; }
    if (xl === xh) { xl -= 1; xh += 1; }
    const ticks = niceTicks(p.min ?? yl, p.max ?? yh, 4), y0 = ticks[0], y1 = ticks[ticks.length - 1];
    const { m, W, pw, ph } = frameOf(H, ticks);
    // like the y axis, the x axis runs between round values
    const xt = niceTicks(xl, xh, Math.max(3, Math.floor(pw / 80))), d0 = xt[0], d1 = xt[xt.length - 1];
    const sx = v => m.l + ((v - d0) / (d1 - d0)) * pw, Y = v => m.t + ph - ((v - y0) / (y1 - y0 || 1)) * ph;
    const g = [];
    axisY(g, m, W, Y, ticks); axisX(g, H, pw, d0, d1, sx);
    for (const q of pts) g.push(marker(SHAPES[q.k % SHAPES.length], sx(q.x), Y(q.y), 3.5, { class: 'ui-chart-point', 'data-tone': tone(q.s, q.k) }));
    const selMark = svgEl('g', { class: 'ui-chart-selmark' }), dots = svgEl('g', { class: 'ui-chart-dots' });
    const cross = svgEl('line', { class: 'ui-chart-cross', visibility: 'hidden' });
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.replaceChildren(...g, selMark, cross, dots);
    geom = { kind: 'scatter', pts, sx, Y, m, ph, W, cross, dots, selMark, visible: pts.map((_, i) => i) };
    if (sel >= 0 && pts[sel]) selMark.append(svgEl('circle', { class: 'ui-chart-seldot', 'data-tone': tone(pts[sel].s, pts[sel].k), cx: sx(pts[sel].x), cy: Y(pts[sel].y), r: 7 }));
  }

  function slices() {
    const s = p.series[0] || { values: [] };
    return p.labels.map((label, i) => ({ i, label, v: s.values[i], tone: s.tones?.[i] || TONES[i % TONES.length] })).filter(q => finite(q.v) && q.v > 0 && !hiddenSlices.has(q.i));
  }
  function renderDonut() {
    const H = p.height, W = Math.max(120, width), list = slices(), total = list.reduce((a, q) => a + q.v, 0);
    const R = Math.min(H / 2 - 6, W / 2 - 6), r = R * 0.62, cx = W / 2, cy = H / 2;
    const g = [];
    let a = -Math.PI / 2;
    const arcs = list.map(q => {
      const sweep = (q.v / (total || 1)) * Math.PI * 2, gap = list.length > 1 ? Math.min(0.02, sweep / 4) : 0;
      const a0 = a + gap / 2, a1 = a + sweep - gap / 2; a += sweep;
      const pt = (rad, ang) => `${(cx + rad * Math.cos(ang)).toFixed(2)},${(cy + rad * Math.sin(ang)).toFixed(2)}`, big = a1 - a0 > Math.PI ? 1 : 0;
      const d = list.length === 1 ? `M${pt(R, -Math.PI / 2)}A${R},${R} 0 1 1 ${pt(R, Math.PI * 1.5 - 0.0001)}L${pt(r, Math.PI * 1.5 - 0.0001)}A${r},${r} 0 1 0 ${pt(r, -Math.PI / 2)}Z`
        : `M${pt(R, a0)}A${R},${R} 0 ${big} 1 ${pt(R, a1)}L${pt(r, a1)}A${r},${r} 0 ${big} 0 ${pt(r, a0)}Z`;
      g.push(svgEl('path', { class: 'ui-chart-slice', 'data-tone': q.tone, 'data-selected': sel === q.i ? '' : null, d }));
      return { ...q, a0: a0 - gap / 2, a1: a1 + gap / 2 };
    });
    const sum = svgEl('text', { class: 'ui-chart-total', x: cx, y: cy + 2, 'text-anchor': 'middle' }); sum.textContent = fmt(total);
    const cap = svgEl('text', { class: 'ui-chart-total-label', x: cx, y: cy + 18, 'text-anchor': 'middle' }); cap.textContent = c.s.t('chart.total');
    svg.setAttribute('viewBox', `0 0 ${W} ${H}`); svg.setAttribute('width', W); svg.setAttribute('height', H);
    svg.replaceChildren(...g, sum, cap);
    geom = { kind: 'donut', arcs, total, cx, cy, R, r, W, visible: arcs.map((_, k) => k) };
  }

  function renderLegend() {
    const donut = kind() === 'donut';
    const entries = donut ? p.labels.map((label, i) => ({ key: i, label, tone: p.series[0]?.tones?.[i] || TONES[i % TONES.length], off: hiddenSlices.has(i), shape: 'bar' }))
      : p.series.map((s, i) => ({ key: s.id, label: s.label, tone: tone(s, i), off: hidden.has(s.id), dashed: s.dashed, shape: kind() === 'scatter' ? SHAPES[i % SHAPES.length] : (s.as || p.type) === 'bar' ? 'bar' : 'line' }));
    if (!p.legend || entries.length < 2) { fill(legend); return; }
    const toggles = p.toggle !== false, on = entries.filter(e => !e.off).length;
    fill(legend, entries.map(e => {
      const kids = [c.h('i', { 'aria-hidden': 'true' }), e.label];
      const attrs = { 'data-tone': e.tone, 'data-dashed': e.dashed ? '' : null, 'data-shape': e.shape, 'data-off': e.off ? '' : null };
      if (!toggles) return c.h('li', attrs, ...kids);
      // the last shown series cannot be turned off
      const b = c.h('button', { type: 'button', class: 'ui-chart-key', ...attrs, 'aria-pressed': String(!e.off), 'aria-disabled': !e.off && on === 1 ? 'true' : null }, ...kids);
      b.addEventListener('click', () => toggleEntry(e.key, donut));
      return c.h('li', {}, b);
    }));
  }
  function toggleEntry(key, donut) {
    const set = donut ? hiddenSlices : hidden, total = donut ? p.labels.length : p.series.length;
    const off = !set.has(key);
    if (off && total - set.size <= 1) return;
    if (off) set.add(key); else set.delete(key);
    render();
    legend.querySelectorAll('button')[donut ? key : p.series.findIndex(s => s.id === key)]?.focus();
    c.emit(el, 'series-toggle', { id: key, hidden: off }, p.onSeriesToggle);
  }

  // the readout of one point: [title, rows: [tone, label, value]]
  function readout(i) {
    if (geom.kind === 'donut') { const q = geom.arcs[i]; return [q.label, [[q.tone, c.s.format.percent(q.v / (geom.total || 1), 0), fmt(q.v)]]]; }
    if (geom.kind === 'scatter') { const q = geom.pts[i]; return [q.s.label, [[tone(q.s, q.k), xText(q.x), fmt(q.y)]]]; }
    return [labelAt(i), shown().map(s => [tone(s, p.series.indexOf(s)), s.label, s.band && finite(s.band.lo?.[i]) ? `${fmt(s.values[i])} (${c.s.t('chart.band', { lo: fmt(s.band.lo[i]), hi: fmt(s.band.hi[i]) })})` : fmt(s.values[i])])];
  }
  function show(i, announce = true) {
    if (!geom?.visible?.length) return;
    const vis = geom.visible;
    if (!vis.includes(i)) i = vis[Math.max(0, Math.min(vis.length - 1, i < vis[0] ? 0 : vis.length - 1))];
    idx = i;
    let x;
    if (geom.kind === 'donut') {
      const q = geom.arcs[i], mid = (q.a0 + q.a1) / 2;
      x = geom.cx + (geom.R + 8) * Math.cos(mid);
      svg.querySelectorAll('.ui-chart-slice').forEach((path, k) => path.toggleAttribute('data-active', k === i));
    } else if (geom.kind === 'scatter') {
      const q = geom.pts[i]; x = geom.sx(q.x);
      geom.dots.replaceChildren(svgEl('circle', { class: 'ui-chart-dot', 'data-tone': tone(q.s, q.k), cx: x, cy: geom.Y(q.y), r: 5 }));
    } else {
      x = geom.X(i);
      geom.cross.setAttribute('x1', x); geom.cross.setAttribute('x2', x); geom.cross.setAttribute('visibility', 'visible');
      geom.dots.replaceChildren(...geom.lines.filter(s => finite(s.values[i])).map(s => svgEl('circle', { class: 'ui-chart-dot', 'data-tone': tone(s, p.series.indexOf(s)), cx: x, cy: geom.Y(s.values[i]), r: 3.5 })));
    }
    const [title, rows] = readout(i);
    fill(tip, c.h('strong', {}, title), rows.map(([t, l, v]) => c.h('div', { 'data-tone': t }, c.h('i', { 'aria-hidden': 'true' }), c.h('span', {}, l), c.h('b', {}, v))), sel === selKey(i) ? c.h('em', {}, c.s.t('chart.selectedMark')) : null);
    tip.hidden = false;
    const tw = tip.offsetWidth, left = Math.min(Math.max(4, x + 12), geom.W - tw - 4);
    tip.style.left = `${x + 12 + tw > geom.W ? Math.max(4, x - tw - 12) : left}px`;
    if (announce) c.s.announce(`${title}: ${rows.map(([, l, v]) => `${l} ${v}`).join(', ')}`, { dedupeMs: 0 });
  }
  function hide() { idx = -1; tip.hidden = true; geom?.cross?.setAttribute('visibility', 'hidden'); geom?.dots?.replaceChildren(); svg.querySelectorAll('.ui-chart-slice[data-active]').forEach(q => q.removeAttribute('data-active')); }
  // a selection is kept by data index (xy, donut) or by position in the sorted points (scatter)
  const selKey = i => (geom?.kind === 'donut' ? geom.arcs[i]?.i : i);
  function select(i) {
    if (!geom?.visible?.length || i < 0) return;
    sel = selKey(i);
    let e;
    if (geom.kind === 'donut') { const q = geom.arcs[i]; e = { index: q.i, label: q.label, value: q.v }; }
    else if (geom.kind === 'scatter') { const q = geom.pts[i]; e = { series: q.s.id, index: q.j, x: q.x, y: q.y }; }
    else e = { index: i, x: xKind() === 'category' ? p.labels[i] : xs()[i], label: labelAt(i), values: Object.fromEntries(p.series.map(s => [s.id, s.values[i] ?? null])) };
    render(); show(i, false);
    c.s.announce(c.s.t('chart.selected', { label: readout(i)[0] }), { dedupeMs: 0 });
    c.emit(el, 'select', e, p.onSelect);
  }
  // the index under a pointer: nearest x (xy), nearest point (scatter), the slice under it (donut)
  function hit(e) {
    const r = svg.getBoundingClientRect(), x = ((e.clientX - r.left) / r.width) * geom.W, y = ((e.clientY - r.top) / r.height) * (geom.H || p.height);
    if (geom.kind === 'donut') {
      const dx = x - geom.cx, dy = y - geom.cy, d = Math.hypot(dx, dy); if (d < geom.r * 0.8 || d > geom.R + 6) return -1;
      let ang = Math.atan2(dy, dx); if (ang < -Math.PI / 2) ang += Math.PI * 2;
      return geom.arcs.findIndex(q => ang >= q.a0 && ang < q.a1);
    }
    if (geom.kind === 'scatter') { let best = -1, bd = Infinity; geom.pts.forEach((q, i) => { const d = Math.hypot(geom.sx(q.x) - x, geom.Y(q.y) - y); if (d < bd) { bd = d; best = i; } }); return bd < 24 ? best : -1; }
    const vis = geom.visible; if (!vis.length) return -1;
    let lo = 0, hi = vis.length - 1;
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (geom.X(vis[mid]) < x) lo = mid; else hi = mid; }
    return Math.abs(geom.X(vis[lo]) - x) <= Math.abs(geom.X(vis[hi]) - x) ? vis[lo] : vis[hi];
  }
  const zoomable = () => !!p.zoom && kind() === 'xy' && xKind() !== 'category' && !!geom?.sx;
  function setRange(r, reason) {
    if (r) {
      const all = xs(); let lo = r[0], hi = r[1];
      if (hi < lo) [lo, hi] = [hi, lo];
      const first = all[0], last = all[all.length - 1];
      if (lo <= first && hi >= last) r = null; else r = [Math.max(first, lo), Math.min(last, hi)];
      if (r && lowerBound(all, r[1] + 1e-9) - lowerBound(all, r[0]) < 2) return; // at least two points stay in view
    }
    range = r;
    render();
    if (range) c.s.announce(c.s.t('chart.showing', { from: xText(range[0]), to: xText(range[1]) }));
    c.emit(el, 'range-change', { range, reason }, p.onRangeChange);
  }
  function zoomBy(f) {
    if (!zoomable()) return;
    const all = xs(), [d0, d1] = range || [all[0], all[all.length - 1]], span = (d1 - d0) * f;
    const at = idx >= 0 && geom.kind === 'xy' ? all[idx] : (d0 + d1) / 2, t = (at - d0) / (d1 - d0 || 1);
    setRange([at - span * t, at + span * (1 - t)], 'keyboard');
  }
  c.on(plot, 'pointermove', e => {
    if (!geom?.visible) return;
    if (drag) {
      const r = plot.getBoundingClientRect(), x = Math.max(0, Math.min(r.width, e.clientX - r.left));
      if (Math.abs(x - drag.x) > 4) drag.moved = true;
      // a drag across a zoomable plot draws the brush; elsewhere it only inspects
      if (drag.zoom && drag.moved) { brush.hidden = false; brush.style.left = `${Math.min(x, drag.x)}px`; brush.style.width = `${Math.abs(x - drag.x)}px`; drag.to = x; return; }
    }
    const best = hit(e);
    if (best >= 0 && best !== idx) show(best, false);
  });
  c.on(plot, 'pointerdown', e => {
    if (e.button || !geom?.visible) return;
    const r = plot.getBoundingClientRect();
    drag = { x: e.clientX - r.left, to: null, moved: false, zoom: zoomable() };
    if (drag.zoom) try { plot.setPointerCapture(e.pointerId); } catch { /* a pointer that is not active (synthetic) */ }
  });
  c.on(plot, 'pointerup', e => {
    const d = drag; drag = null; brush.hidden = true;
    if (!d) return;
    if (d.moved && d.zoom && d.to != null) {
      const r = svg.getBoundingClientRect(), k = geom.W / r.width, inv = px => geom.d0 + ((px * k - geom.m.l) / (geom.W - geom.m.l - geom.m.r)) * (geom.d1 - geom.d0);
      const pr = plot.getBoundingClientRect(), off = r.left - pr.left;
      setRange([inv(Math.min(d.x, d.to) - off), inv(Math.max(d.x, d.to) - off)], 'brush');
      return;
    }
    if (!d.moved && p.onSelect) { const i = hit(e); if (i >= 0) select(i); }
  });
  c.on(plot, 'pointercancel', () => { drag = null; brush.hidden = true; });
  c.on(plot, 'pointerleave', () => { if (c.doc.activeElement !== plot && !drag) hide(); });
  c.on(plot, 'keydown', e => {
    const vis = geom?.visible || [], at = vis.indexOf(idx), step = { ArrowRight: 1, ArrowLeft: -1, ArrowUp: 1, ArrowDown: -1 }[e.key];
    const go = k => show(vis[Math.max(0, Math.min(vis.length - 1, k))]);
    if (step) { e.preventDefault(); go(at < 0 ? 0 : at + step); }
    else if (e.key === 'PageDown' || e.key === 'PageUp') { e.preventDefault(); const big = Math.max(1, Math.round(vis.length / 10)); go(at < 0 ? 0 : at + (e.key === 'PageDown' ? big : -big)); }
    else if (e.key === 'Home') { e.preventDefault(); go(0); }
    else if (e.key === 'End') { e.preventDefault(); go(vis.length - 1); }
    else if ((e.key === 'Enter' || e.key === ' ') && p.onSelect && idx >= 0) { e.preventDefault(); select(idx); }
    else if ((e.key === '+' || e.key === '=') && zoomable()) { e.preventDefault(); zoomBy(0.5); }
    else if (e.key === '-' && zoomable()) { e.preventDefault(); zoomBy(2); }
    else if (e.key === '0' && zoomable() && range) { e.preventDefault(); setRange(null, 'keyboard'); }
    else if (e.key === 'Escape' && idx >= 0) { e.preventDefault(); hide(); }
  });
  c.on(plot, 'blur', hide);
  c.on(resetBtn, 'click', () => { setRange(null, 'reset'); plot.focus(); });
  // the table lists every point, not only the window; long ones are virtual
  const tableSignature = () => `${kind()}:${xKind()}:${p.series.map(s => s.id).join()}`;
  function tableProps() {
    const virtual = n => (n > 200 ? { height: '16rem' } : undefined);
    if (kind() === 'donut') { const s = p.series[0] || { values: [] }, total = s.values.reduce((a, v) => a + (finite(v) && v > 0 ? v : 0), 0); return { label: p.label, rows: p.labels.map((l, i) => ({ id: i, x: l, v: s.values[i], pc: finite(s.values[i]) ? s.values[i] / (total || 1) : null })), columns: [{ id: 'x', label: '' }, { id: 'v', label: s.label || '', align: 'end', cell: r => fmt(r.v) }, { id: 'pc', label: '%', align: 'end', cell: r => (r.pc == null ? '—' : c.s.format.percent(r.pc, 0)) }] }; }
    if (kind() === 'scatter') { const rows = []; p.series.forEach(s => (s.points || []).forEach((q, j) => { const pt = pointOf(q); rows.push({ id: `${s.id}:${j}`, s: s.label, x: pt.x, y: pt.y }); })); return { label: p.label, rows, virtual: virtual(rows.length), columns: [{ id: 's', label: '' }, { id: 'x', label: 'x', align: 'end', cell: r => xText(r.x) }, { id: 'y', label: 'y', align: 'end', cell: r => fmt(r.y) }] }; }
    const n = xKind() === 'category' ? p.labels.length : (p.x || []).length;
    const all = xs(), cat = xKind() === 'category';
    return { label: p.label, virtual: virtual(n), rows: Array.from({ length: n }, (_, i) => ({ id: i, x: cat ? p.labels[i] : xText(all[i]), ...Object.fromEntries(p.series.map(s => [s.id, s.values[i]])) })),
      columns: [{ id: 'x', label: '' }, ...p.series.map(s => ({ id: s.id, label: s.label, align: 'end', cell: r => fmt(r[s.id]) }))] };
  }
  function openTable() { tableKey = tableSignature(); table = createTable(dataBox, tableProps(), c.s); }
  c.on(dataBtn, 'click', () => {
    dataBox.hidden = !dataBox.hidden; dataBtn.setAttribute('aria-expanded', String(!dataBox.hidden));
    if (!dataBox.hidden && !table) openTable();
    dataBtn.lastChild.textContent = c.s.t(dataBox.hidden ? 'chart.data' : 'chart.hideData');
  });
  const ro = new c.win.ResizeObserver(() => { if (plot.clientWidth !== width && !frame) frame = c.win.requestAnimationFrame(render); });
  ro.observe(plot);
  c.cleanup(() => { ro.disconnect(); c.win.cancelAnimationFrame(frame); table?.destroy(); stateHandle?.destroy?.(); });
  container.append(el);
  render();
  return {
    root: el,
    get range() { return range; },
    get selected() { return sel; },
    update(n) {
      p = { ...p, ...n };
      if ('series' in n) { const ids = new Set(p.series.map(s => s.id)); hidden = new Set([...hidden].filter(id => ids.has(id))); for (const s of p.series) if (s.hidden) hidden.add(s.id); }
      if ('range' in n) range = n.range || null;
      if ('selected' in n) sel = n.selected ?? -1;
      render();
    },
    /** Zooms to [from, to] on a numeric or time axis, or back to everything with null. */
    setRange: r => setRange(r, 'api'),
    focus: () => plot.focus(), destroy: () => c.destroy(),
  };
}
