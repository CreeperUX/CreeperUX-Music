// Async action state for any mutation (D22, D30): save, toggle, publish, inline edit.
// States: idle → pending → confirmed | failed (retry) | superseded; optional opt-in "unconfirmed" when the server
// acknowledged but the result is not yet observed. Latest intent wins: a newer run() supersedes older ones and their
// late results are ignored. Business timing (timeouts) is never affected by motion settings.
// Read-back (G16, as 1.0's PendingCommand): observe(value) reports what the device or server now holds. A match confirms
// an unconfirmed change, and a match that arrives while the action is still pending confirms it as soon as it settles.
// readbackTimeout fails a change that is never observed.
const same = (a, b) => Object.is(a, b) || (a != null && b != null && String(a) === String(b));
export function createAsyncAction({ onChange, confirmTimeout = 0, readbackTimeout = 0, unconfirmed = false, matches = same, clearConfirmedAfter = 2000, setTimeout: st = globalThis.setTimeout.bind(globalThis), clearTimeout: ct = globalThis.clearTimeout.bind(globalThis) } = {}) {
  let seq = 0, destroyed = false, last = null, clearTimer = 0, timeoutTimer = 0, seen = false;
  let snap = { phase: 'idle', value: undefined, error: null, attempt: 0, id: 0 };
  const set = next => { snap = { ...snap, ...next }; if (!destroyed) onChange?.(snap); };
  const clearTimers = () => { ct(clearTimer); ct(timeoutTimer); clearTimer = timeoutTimer = 0; };

  /**
   * run(task, { value }) — task(signal) returns a Promise. Resolve with { unconfirmed: true } to enter the opt-in
   * unconfirmed state; call confirm() later when the change is observed.
   */
  async function run(task, { value, attempt = 1 } = {}) {
    if (destroyed) return { status: 'destroyed' };
    const id = ++seq, ctrl = new AbortController();
    if (last && last.id !== id && (snap.phase === 'pending' || snap.phase === 'unconfirmed')) { last.ctrl.abort(); }
    last = { id, ctrl, task, value }; seen = false;
    clearTimers();
    set({ phase: 'pending', value, error: null, attempt, id });
    if (confirmTimeout) timeoutTimer = st(() => { if (id === seq && snap.phase === 'pending') { ctrl.abort(); set({ phase: 'failed', error: new Error('timeout') }); } }, confirmTimeout);
    try {
      const result = await task(ctrl.signal);
      if (id !== seq || destroyed) return { status: 'superseded' };
      ct(timeoutTimer);
      if (snap.phase !== 'pending') return { status: snap.phase };
      if (unconfirmed && result && result.unconfirmed && !seen) {
        set({ phase: 'unconfirmed' });
        if (readbackTimeout) timeoutTimer = st(() => { if (id === seq && snap.phase === 'unconfirmed') set({ phase: 'failed', error: new Error('timeout') }); }, readbackTimeout);
        return { status: 'unconfirmed', result };
      }
      settle(id);
      return { status: 'confirmed', result };
    } catch (error) {
      if (id !== seq || destroyed) return { status: 'superseded' };
      if (ctrl.signal.aborted && snap.phase === 'failed') return { status: 'failed', error: snap.error };
      ct(timeoutTimer);
      set({ phase: 'failed', error });
      return { status: 'failed', error };
    }
  }
  function settle(id) {
    set({ phase: 'confirmed' });
    if (clearConfirmedAfter) clearTimer = st(() => { if (id === seq && snap.phase === 'confirmed') set({ phase: 'idle' }); }, clearConfirmedAfter);
  }
  return {
    run,
    /** Read-back: the value the device or server now holds. A match confirms the change, even before its acknowledgement. */
    observe(value) {
      if (destroyed || !matches(snap.value, value)) return;
      if (snap.phase === 'pending') seen = true;
      else if (snap.phase === 'unconfirmed') { clearTimers(); settle(seq); }
    },
    retry: () => (last ? run(last.task, { value: last.value, attempt: snap.attempt + 1 }) : Promise.resolve({ status: 'idle' })),
    /** Opt-in: the change was observed (only meaningful after an "unconfirmed" result). */
    confirm(id = seq) { if (id === seq && snap.phase === 'unconfirmed') { clearTimers(); settle(id); } },
    /** Cancel the running action; its late result will be ignored. */
    cancel() { if (snap.phase === 'pending' || snap.phase === 'unconfirmed') { seq++; last?.ctrl.abort(); clearTimers(); set({ phase: 'idle', error: null }); } },
    reset() { seq++; clearTimers(); set({ phase: 'idle', value: undefined, error: null, attempt: 0 }); },
    get state() { return snap; },
    get pending() { return snap.phase === 'pending'; },
    destroy() { if (destroyed) return; destroyed = true; seq++; last?.ctrl.abort(); clearTimers(); },
  };
}
