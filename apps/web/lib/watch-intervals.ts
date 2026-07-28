/**
 * Client-side accumulation of watched ranges.
 *
 * The player samples `currentTime` on a timer and has to turn a stream of
 * positions into the intervals it reports. The rule that matters is that a
 * *jump* between samples is a seek, not playback: dragging the scrubber from
 * 0:05 to 9:50 must produce two short intervals, never one nine-minute one.
 *
 * Pulled out of the component and made pure so it can be tested without a
 * browser, a video element or a clock. The server clamps everything this
 * produces anyway — it trusts no client — but a client that reports honestly is
 * what makes the clamp a safety net rather than the only defence.
 */

export interface Interval {
  start: number;
  end: number;
}

export interface SamplerState {
  /** The run currently being extended, if any. */
  run: Interval | null;
  /** The previous sampled position, or null when playback is not advancing. */
  lastPosition: number | null;
  /** Completed runs waiting to be sent. */
  pending: Interval[];
}

export const emptySampler = (): SamplerState => ({ run: null, lastPosition: null, pending: [] });

/**
 * A jump larger than this between samples is a seek.
 *
 * Generous relative to the 1s sampling interval because browsers throttle
 * timers in a background tab: a tab hidden for two seconds legitimately
 * advances more than one sample's worth, and calling that a seek would fragment
 * every interval without changing what gets credited.
 */
export const SEEK_THRESHOLD_SECONDS = 3;

/** Runs shorter than this are seek noise and are dropped. */
export const MIN_RUN_SECONDS = 0.5;

/** Close the current run and bank it if it is long enough to matter. */
export function closeRun(state: SamplerState): SamplerState {
  if (!state.run) return { ...state, run: null };
  const long = state.run.end - state.run.start >= MIN_RUN_SECONDS;
  return {
    run: null,
    lastPosition: state.lastPosition,
    pending: long ? [...state.pending, state.run] : state.pending,
  };
}

/**
 * Fold one sample into the state.
 *
 * `playing` is false when the element is paused, seeking or ended. Paused time
 * is not watched time, so it closes the run — which is what stops a lesson left
 * paused overnight from being credited with the night.
 */
export function sample(state: SamplerState, position: number, playing: boolean): SamplerState {
  if (!playing || !Number.isFinite(position)) {
    return { ...closeRun(state), lastPosition: null };
  }

  const previous = state.lastPosition;

  if (previous === null || Math.abs(position - previous) > SEEK_THRESHOLD_SECONDS) {
    // First sample after a pause, or a jump. Either way the previous run ended
    // and a new zero-length one starts here.
    const closed = closeRun(state);
    return { ...closed, run: { start: position, end: position }, lastPosition: position };
  }

  // Playback advanced normally, so extend. Guarded against a rewind smaller
  // than the threshold (a player correcting its own position), which would
  // otherwise make `end` move backwards and produce a negative-length interval.
  const run = state.run
    ? { start: state.run.start, end: Math.max(state.run.end, position) }
    : { start: previous, end: position };

  return { run, lastPosition: position, pending: state.pending };
}

/**
 * Take everything accumulated so far, closing the open run.
 *
 * Returns the intervals to send plus the state to keep. The open run's *end* is
 * preserved as the start of the next one so a beat boundary mid-playback does
 * not lose the second it lands on.
 */
export function drain(state: SamplerState): { intervals: Interval[]; state: SamplerState } {
  const closed = closeRun(state);
  return {
    intervals: closed.pending,
    state: { run: null, lastPosition: state.lastPosition, pending: [] },
  };
}
