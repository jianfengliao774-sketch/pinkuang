const locks = new WeakMap();

/** A preview and its result can overlap while a submitted operation settles. */
export function lockDialogScroll(document) {
  let state = locks.get(document);
  if (!state) { state = { count: 0, overflow: document.body.style.overflow }; locks.set(document, state); }
  state.count++;
  document.body.style.overflow = 'hidden';
  let released = false;
  return () => {
    if (released) return;
    released = true;
    if (--state.count === 0) { document.body.style.overflow = state.overflow; locks.delete(document); }
  };
}
