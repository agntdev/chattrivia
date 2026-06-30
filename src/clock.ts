/**
 * Injectable clock seam. Every schedule, cutoff, and expiry routes through
 * `now()` — never call `Date.now()` or `new Date()` inline. Override
 * `__setClock` in tests to drive time-based behavior deterministically.
 */
let _clockNow: () => number = () => Date.now();

/** Current time in Unix milliseconds. */
export function now(): number {
  return _clockNow();
}

/** Override the clock (test hook). */
export function __setClock(fn: () => number): void {
  _clockNow = fn;
}

/** Reset to the real clock (test hook). */
export function __resetClock(): void {
  _clockNow = () => Date.now();
}
