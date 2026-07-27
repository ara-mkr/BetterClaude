/**
 * Render coalescing.
 *
 * A busy `claude` session emits PTY data far faster than a terminal can usefully
 * repaint. Feeding every chunk straight into React would spend all our time in
 * reconciliation and produce visible tearing. Instead we run the callback at most
 * once per interval, with a guaranteed trailing call so the final frame is never
 * dropped.
 */

export interface Throttler {
  /** Request a call. Runs immediately if idle, otherwise defers to the trailing edge. */
  trigger(): void;
  /** Run any deferred call right now and clear the cooldown. */
  flush(): void;
  /** Drop any deferred call and stop. */
  dispose(): void;
}

export function createThrottler(fn: () => void, intervalMs: number): Throttler {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let pending = false;
  let disposed = false;

  const fire = (): void => {
    pending = false;
    fn();
    // Start the cooldown. Anything arriving during it fires once at the end,
    // which keeps a steady stream at a fixed frame rate rather than bursting.
    timer = setTimeout(() => {
      timer = undefined;
      if (pending && !disposed) fire();
    }, intervalMs);
  };

  return {
    trigger(): void {
      if (disposed) return;
      if (timer) {
        pending = true;
        return;
      }
      fire();
    },

    flush(): void {
      if (disposed) return;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
      if (pending) {
        pending = false;
        fn();
      }
    },

    dispose(): void {
      disposed = true;
      pending = false;
      if (timer) {
        clearTimeout(timer);
        timer = undefined;
      }
    },
  };
}
