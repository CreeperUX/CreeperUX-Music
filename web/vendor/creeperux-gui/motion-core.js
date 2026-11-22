import { MOTION_ROLES, MOTION_REDUCED } from './tokens.js';

// CreeperUX motion core (D19, D27). Every animated element carries a small model of its channels
// (x, y, sx, sy, o, h, w). Each channel is a tween or an analytic spring evaluated in JS and rendered as a sampled
// Web Animations keyframe animation, so transform / opacity stay on the compositor. A new target interrupts from the
// modelled current value and, for springs, the current velocity: reversals continue instead of jumping, and there is
// never more than one animation per element. Roles and timings come from tokens/tokens.json (quiet profile).

const DEFAULTS = { x: 0, y: 0, sx: 1, sy: 1, o: 1 };
const EPS = { x: 0.25, y: 0.25, sx: 0.0015, sy: 0.0015, o: 0.004, h: 0.4, w: 0.4 };
const FRAME = 1 / 60;
const MAX_T = 2.4;

function bezier(p1x, p1y, p2x, p2y) {
  const cx = 3 * p1x, bx = 3 * (p2x - p1x) - cx, ax = 1 - cx - bx;
  const cy = 3 * p1y, by = 3 * (p2y - p1y) - cy, ay = 1 - cy - by;
  const sx = t => ((ax * t + bx) * t + cx) * t, sy = t => ((ay * t + by) * t + cy) * t, dx = t => (3 * ax * t + 2 * bx) * t + cx;
  return x => {
    if (x <= 0) return 0;
    if (x >= 1) return 1;
    let t = x;
    for (let i = 0; i < 8; i++) { const e = sx(t) - x; if (Math.abs(e) < 1e-6) break; const d = dx(t); if (Math.abs(d) < 1e-6) break; t -= e / d; }
    return sy(Math.min(1, Math.max(0, t)));
  };
}

/** Displacement of a spring from its target (with analytic velocity f.vel). response = undamped period (s), zeta = damping ratio. */
function springCurve(response, zeta, x0, v0) {
  const w0 = (2 * Math.PI) / response;
  let f, fv;
  if (zeta < 1) {
    const wd = w0 * Math.sqrt(1 - zeta * zeta), A = x0, B = (v0 + zeta * w0 * x0) / wd, k = zeta * w0;
    f = t => Math.exp(-k * t) * (A * Math.cos(wd * t) + B * Math.sin(wd * t));
    fv = t => Math.exp(-k * t) * ((B * wd - k * A) * Math.cos(wd * t) - (A * wd + k * B) * Math.sin(wd * t));
  } else if (zeta === 1) {
    const B = v0 + w0 * x0;
    f = t => Math.exp(-w0 * t) * (x0 + B * t);
    fv = t => Math.exp(-w0 * t) * (B - w0 * (x0 + B * t));
  } else {
    const s = w0 * Math.sqrt(zeta * zeta - 1), r1 = -zeta * w0 + s, r2 = -zeta * w0 - s, C2 = (v0 - r1 * x0) / (r2 - r1), C1 = x0 - C2;
    f = t => C1 * Math.exp(r1 * t) + C2 * Math.exp(r2 * t);
    fv = t => C1 * r1 * Math.exp(r1 * t) + C2 * r2 * Math.exp(r2 * t);
  }
  f.vel = fv;
  return f;
}

/** One channel's motion: {to, at(t), vel(t), end}. t in seconds. */
function makeChannel(spec, from, to, v0 = 0, name = 'x') {
  if (!spec || spec.t === 'instant' || (from === to && Math.abs(v0) < EPS[name] * 4)) return { to, at: () => to, vel: () => 0, end: 0 };
  if (spec.t === 'spring') {
    const f = springCurve(spec.r, spec.z, from - to, v0);
    const vel = f.vel;
    let end = 0;
    for (let t = 0; t <= MAX_T; t += FRAME / 2) { end = t; if (Math.abs(f(t)) < EPS[name] && Math.abs(vel(t)) < EPS[name] * 12) break; }
    return { to, at: t => (t >= end ? to : to + f(t)), vel: t => (t >= end ? 0 : vel(t)), end };
  }
  const ease = bezier(...spec.e), d = spec.d;
  const at = t => (t >= d ? to : from + (to - from) * ease(t / d));
  return { to, at, vel: t => (t >= d ? 0 : (at(Math.min(d, t + 1e-3)) - at(t)) / 1e-3), end: d };
}

/** Pure curve helpers (exported for tests and for hosts that drive their own canvases). */
export const curves = Object.freeze({ bezier, spring: springCurve, channel: makeChannel });

/**
 * createMotion({ roles, speed, reduced, document })
 * - roles: motion roles (defaults to the quiet token roles)
 * - speed: slow-motion factor (1 = normal); business timing is never affected
 * - reduced: 'system' (follow prefers-reduced-motion) | true | false
 */
export function createMotion({ roles = MOTION_ROLES, speed = 1, reduced = 'system', document: doc = globalThis.document } = {}) {
  const win = doc.defaultView;
  const state = new WeakMap();
  const live = new Set();
  const media = win.matchMedia('(prefers-reduced-motion: reduce)');
  let slow = speed, pref = reduced, destroyed = false;
  const isReduced = () => pref === true || (pref === 'system' && media.matches);
  // The model runs on the document timeline so it matches what is on screen this frame (not performance.now()).
  const clock = () => doc.timeline?.currentTime ?? win.performance.now();
  const scaled = () => (doc.hidden ? 0 : slow);

  function roleSpec(role, name) {
    if (role === 'instant') return { t: 'instant' };
    if (isReduced()) return name === 'o' ? MOTION_REDUCED.opacity : { t: 'instant' };
    return roles[role] || roles.layout;
  }
  function css(v, rest) {
    const out = {};
    if ('x' in v || 'y' in v || 'sx' in v || 'sy' in v) {
      const x = v.x ?? rest.x ?? 0, y = v.y ?? rest.y ?? 0, sx = v.sx ?? rest.sx ?? 1, sy = v.sy ?? rest.sy ?? 1;
      out.transform = `translate3d(${x.toFixed(2)}px,${y.toFixed(2)}px,0) scale(${sx.toFixed(4)},${sy.toFixed(4)})`;
    }
    if ('o' in v) out.opacity = Math.max(0, Math.min(1, v.o)).toFixed(3);
    if ('h' in v) out.height = `${Math.max(0, v.h).toFixed(1)}px`;
    if ('w' in v) out.width = `${Math.max(0, v.w).toFixed(1)}px`;
    return out;
  }
  const elapsed = (st, now) => (st.speed === 0 ? Infinity : Math.max(0, (now - st.start) / 1000 / st.speed - st.delay));
  function commit(el, st, values) {
    st.rest = { ...st.rest, ...values };
    const r = st.rest;
    const moved = ['x', 'y', 'sx', 'sy'].some(n => n in r && Math.abs(r[n] - DEFAULTS[n]) > 1e-4);
    el.style.transform = moved ? css({ x: r.x, y: r.y, sx: r.sx, sy: r.sy }, r).transform : '';
    el.style.opacity = 'o' in r && r.o < 0.999 ? String(r.o) : '';
    if ('h' in values) el.style.height = st.autoHeight ? '' : `${r.h}px`;
    if ('w' in values) el.style.width = `${r.w}px`;
  }
  function read(el, name, now = clock()) {
    const st = state.get(el);
    if (st?.ch[name]) { const t = elapsed(st, now); return { v: st.ch[name].at(t), dv: st.ch[name].vel(t) }; }
    if (name === 'h') return { v: st && !st.autoHeight && st.rest?.h != null ? st.rest.h : el.getBoundingClientRect().height, dv: 0 };
    if (name === 'w') return { v: st?.rest?.w ?? el.getBoundingClientRect().width, dv: 0 };
    return { v: st?.rest?.[name] ?? DEFAULTS[name], dv: 0 };
  }
  function stop(el, jump = true) {
    const st = state.get(el);
    if (!st) return;
    if (st.anim) {
      const now = clock(), vals = {};
      for (const [n, c] of Object.entries(st.ch)) vals[n] = jump ? c.to : c.at(elapsed(st, now));
      st.anim.onfinish = null; st.anim.cancel(); st.anim = null; live.delete(st);
      if (jump) { commit(el, st, vals); st.ch = {}; }
    }
    if (st.resolve) { const r = st.resolve; st.resolve = null; r(false); }
  }
  /** animate(el, {x,y,sx,sy,o,h,w}, {role, from, vel, delay, autoHeight}) → Promise<boolean> (false if interrupted). */
  function animate(el, to, opts = {}) {
    if (destroyed) return Promise.resolve(false);
    const { role = 'layout', from = {}, vel = {}, delay = 0, autoHeight = false } = opts;
    const now = clock(), prev = state.get(el);
    const st = { ch: {}, rest: prev?.rest || {}, start: now, delay, speed: scaled(), autoHeight };
    const names = new Set(Object.keys(to));
    if (prev) for (const n of Object.keys(prev.ch)) names.add(n);
    for (const n of names) {
      const cur = n in from ? { v: from[n], dv: vel[n] ?? 0 } : read(el, n, now);
      const target = n in to ? to[n] : prev.ch[n].to;
      st.ch[n] = makeChannel(roleSpec(n in to ? role : prev.role || role, n), cur.v, target, n in vel ? vel[n] : cur.dv, n);
    }
    st.role = role;
    stop(el, false);
    state.set(el, st);
    const end = Math.max(0, ...Object.values(st.ch).map(c => c.end));
    const finals = {};
    for (const [n, c] of Object.entries(st.ch)) finals[n] = c.to;
    if (end === 0 || st.speed === 0) { commit(el, st, finals); st.ch = {}; return Promise.resolve(true); }
    const frames = [];
    for (let t = 0; t < end; t += FRAME) frames.push(css(Object.fromEntries(Object.entries(st.ch).map(([n, c]) => [n, c.at(t)])), st.rest));
    frames.push(css(finals, st.rest));
    const anim = el.animate(frames, { duration: end * st.speed * 1000, delay: delay * st.speed * 1000, fill: 'both', easing: 'linear' });
    if (doc.timeline?.currentTime != null) anim.startTime = now; // time 0 = the pose sampled above
    st.anim = anim;
    live.add(st);
    return new Promise(resolve => {
      st.resolve = resolve;
      anim.onfinish = () => {
        if (state.get(el) !== st) return;
        commit(el, st, finals); anim.cancel();
        st.ch = {}; st.anim = null; live.delete(st); st.resolve = null;
        resolve(true);
      };
    });
  }
  function reset(el) { stop(el, true); state.delete(el); el.style.transform = ''; el.style.opacity = ''; }
  /** FLIP: measure → mutate → measure → animate the difference from the current visual pose. */
  function flip(els, mutate, { role = 'layout', stagger = 0, onlyVisible = true } = {}) {
    const vh = win.innerHeight, before = new Map();
    for (const el of els) {
      if (!el.isConnected) continue;
      const r = el.getBoundingClientRect();
      const st = state.get(el);
      if (onlyVisible && (r.bottom < -40 || r.top > vh + 40) && !st?.anim) continue;
      const x = read(el, 'x'), y = read(el, 'y'), other = {};
      if (st?.anim) { const t = elapsed(st, clock()); for (const [n, c] of Object.entries(st.ch)) if (n !== 'x' && n !== 'y') other[n] = { v: c.at(t), dv: c.vel(t), to: c.to }; }
      before.set(el, { left: r.left, top: r.top, vx: x.dv, vy: y.dv, other, visible: r.height > 0 });
    }
    mutate();
    for (const el of before.keys()) {
      const st = state.get(el);
      if (st?.anim) { st.anim.onfinish = null; st.anim.cancel(); st.anim = null; live.delete(st); }
      if (st?.resolve) { const r = st.resolve; st.resolve = null; r(false); }
      el.style.transform = '';
    }
    const after = new Map();
    for (const el of before.keys()) if (el.isConnected) after.set(el, el.getBoundingClientRect());
    let i = 0;
    const done = [];
    for (const [el, b] of before) {
      const a = after.get(el);
      if (!a || a.height === 0 || !b.visible) continue;
      const dx = b.left - a.left, dy = b.top - a.top, st = state.get(el);
      if (st) { st.ch = {}; if (st.rest) { st.rest.x = 0; st.rest.y = 0; } }
      const to = { x: 0, y: 0 }, from = { x: dx, y: dy }, vel = { x: b.vx, y: b.vy };
      for (const [n, o] of Object.entries(b.other)) { to[n] = o.to; from[n] = o.v; vel[n] = o.dv; }
      const still = Math.abs(dx) < 0.5 && Math.abs(dy) < 0.5 && Math.abs(b.vx) + Math.abs(b.vy) < 1;
      const offscreen = (a.bottom < -40 || a.top > vh + 40) && (b.top < -40 || b.top > vh + 40);
      if ((still || offscreen) && !Object.keys(b.other).length) continue;
      done.push(animate(el, to, { role, from, vel, delay: still ? 0 : stagger * Math.min(i++, 12) }));
    }
    return Promise.all(done);
  }
  function finishAll() { for (const st of [...live]) st.anim?.finish(); }
  const onVisibility = () => { if (doc.hidden) finishAll(); };
  doc.addEventListener('visibilitychange', onVisibility);

  return {
    animate, stop, reset, flip, read, finishAll,
    /** Resolved timing spec for a role (after reduced-motion rules). */
    spec: roleSpec,
    get activeCount() { return live.size; },
    get speed() { return slow; },
    set speed(s) { slow = Number(s) > 0 ? Number(s) : 1; },
    /** 'system' | true | false */
    get reduced() { return pref; },
    set reduced(r) { pref = r === 'system' ? 'system' : !!r; if (isReduced()) finishAll(); },
    get isReduced() { return isReduced(); },
    get destroyed() { return destroyed; },
    destroy() { if (destroyed) return; finishAll(); destroyed = true; doc.removeEventListener('visibilitychange', onVisibility); },
  };
}
