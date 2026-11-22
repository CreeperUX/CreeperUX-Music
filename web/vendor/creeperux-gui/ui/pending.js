// The pending state of a value control (D22, GAPS.md G16), shared by the checkbox, radio group, segmented control, select
// and slider; the switch has its own, older copy of the same behaviour. With an `action`, a change shows at once
// (optimistic) while the field says "Saving…" and then "Saved"; a failure puts the confirmed value back and offers
// Retry. Latest intent wins: a newer change supersedes an older one still in flight. With a read-back action (it
// resolves { unconfirmed: true }), the field says "Sent, not yet confirmed" until handle.observe(value) sees it.
import { createAsyncAction } from '../async-action.js';

/**
 * createPending(c, { busy: Element, apply(value), readbackTimeout }) → { el, confirmed, setConfirmed(v), run(value, task),
 * observe(v), retry(), readonly state, readonly pending }
 * busy gets aria-busy while pending; apply(value) shows a value without reporting it (used to put the confirmed one back).
 */
export function createPending(c, { busy, apply, readbackTimeout = 0 }) {
  const status = c.h('span', { class: 'ui-pending-status', role: 'status' });
  const retryBtn = c.h('button', { type: 'button', class: 'ui-button ui-pending-retry', 'data-variant': 'ghost', hidden: true });
  const el = c.h('div', { class: 'ui-pending', hidden: true }, status, retryBtn);
  let confirmed, wanted;
  const action = createAsyncAction({
    unconfirmed: true, readbackTimeout, clearConfirmedAfter: 1600,
    onChange: s => {
      if (s.phase === 'pending') busy.setAttribute('aria-busy', 'true'); else busy.removeAttribute('aria-busy');
      el.dataset.phase = s.phase;
      el.hidden = s.phase === 'idle';
      status.textContent = s.phase === 'idle' ? '' : c.s.t(`action.${s.phase}`);
      retryBtn.hidden = s.phase !== 'failed'; retryBtn.textContent = c.s.t('retry');
      if (s.phase === 'failed') apply(confirmed);
      if (s.phase === 'confirmed') confirmed = s.value;
    },
  });
  c.cleanup(() => action.destroy());
  async function run(value, task) { wanted = { value, task }; return action.run(signal => task(value, signal), { value }); }
  function retry() { if (!wanted) return; apply(wanted.value); run(wanted.value, wanted.task); }
  c.on(retryBtn, 'click', retry);
  return {
    el, run, retry,
    get confirmed() { return confirmed; },
    setConfirmed(v) { confirmed = v; },
    observe: v => action.observe(v),
    get state() { return action.state; },
    get pending() { return action.state.phase === 'pending' || action.state.phase === 'unconfirmed'; },
  };
}

export const IDLE = Object.freeze({ phase: 'idle', value: undefined, error: null, attempt: 0, id: 0 });
/**
 * Mounts the pending UI the first time a control's action runs; place(el) puts its status line into the layout. The
 * confirmed value is tracked from the start, so a failure on the very first change still puts the old value back:
 * call sync(value) whenever the value changes without an action (the host's update(), or a change with no action).
 */
export function pendingValue(c, { place, busy, apply, current }) {
  let x = null, confirmed = current();
  return {
    get() { if (!x) { x = createPending(c, { busy, apply }); x.setConfirmed(confirmed); place(x.el); } return x; },
    get mounted() { return x; },
    get state() { return x ? x.state : IDLE; },
    observe: v => x?.observe(v),
    sync: v => { if (!x) confirmed = v; else if (!x.pending) x.setConfirmed(v); },
  };
}
