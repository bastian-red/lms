/**
 * Watch-progress arithmetic.
 *
 * A lesson is "complete" when the student has actually seen enough of it, and
 * the only honest measure of that is the set of distinct seconds they covered.
 * Tracking `currentTime` instead is what makes every naive video course
 * completable by dragging the scrubber to the end, so this module never looks at
 * a position: it merges the half-open intervals `[start, end)` the player
 * reports and measures their union.
 *
 * Pure and deterministic on purpose. No clock, no I/O, no database. Everything
 * here is same-input-same-output, which is why it is the most heavily tested
 * file in the repo and why the API can call it inside a transaction without
 * thinking about it.
 */

/** A half-open watched range in seconds from the start of the media. */
export interface Interval {
  start: number;
  end: number;
}

/**
 * Intervals shorter than this are dropped. Seeking emits a flurry of
 * sub-frame ranges; keeping them inflates the stored array without moving
 * coverage by a measurable amount.
 */
export const MIN_INTERVAL_SECONDS = 0.5;

/** Default share of the media that must be covered before a lesson completes. */
export const DEFAULT_COMPLETION_THRESHOLD = 0.9;

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * Coerce whatever came out of the JSON column (or off the wire) into intervals.
 *
 * The stored shape is `Json`, so a row written by an older version, by hand, or
 * by a bug is still a value this has to survive. Anything unparseable is
 * dropped rather than thrown on: a corrupt progress row must not make the lesson
 * page 500.
 */
export function parseIntervals(value: unknown): Interval[] {
  if (!Array.isArray(value)) return [];
  const out: Interval[] = [];
  for (const entry of value) {
    if (Array.isArray(entry) && entry.length >= 2) {
      const [start, end] = entry;
      if (isFiniteNumber(start) && isFiniteNumber(end)) out.push({ start, end });
      continue;
    }
    if (entry && typeof entry === 'object') {
      const { start, end } = entry as { start?: unknown; end?: unknown };
      if (isFiniteNumber(start) && isFiniteNumber(end)) out.push({ start, end });
    }
  }
  return out;
}

/**
 * Clamp an interval into `[0, duration]` and reject the degenerate ones.
 *
 * This is the first half of the anti-cheat story. A client can post any numbers
 * it likes, including negative starts, ends past the media duration, and
 * reversed pairs; none of those may ever reach the merge step, because the
 * merge is honest arithmetic and would faithfully count a fabricated
 * `[0, 99999]` as full coverage.
 */
export function sanitizeInterval(interval: Interval, duration: number): Interval | null {
  if (!isFiniteNumber(interval.start) || !isFiniteNumber(interval.end)) return null;
  if (!isFiniteNumber(duration) || duration <= 0) return null;
  const start = Math.max(0, Math.min(interval.start, duration));
  const end = Math.max(0, Math.min(interval.end, duration));
  if (end - start < MIN_INTERVAL_SECONDS) return null;
  return { start, end };
}

/**
 * Merge overlapping and touching intervals into a minimal, sorted set.
 *
 * Sorting by start and folding forward is O(n log n) and, more importantly, is
 * the only version of this that survives out-of-order input. The heartbeat
 * arrives over the network, so ranges genuinely do land out of order, and a
 * fold that assumed sortedness would double-count every one of them.
 */
export function mergeIntervals(intervals: Interval[]): Interval[] {
  const valid = intervals.filter((i) => isFiniteNumber(i.start) && isFiniteNumber(i.end) && i.end > i.start);
  if (valid.length === 0) return [];

  const sorted = [...valid].sort((a, b) => a.start - b.start || a.end - b.end);
  const merged: Interval[] = [];
  // `sorted` is non-empty, but noUncheckedIndexedAccess does not know that.
  let current: Interval = { start: sorted[0]!.start, end: sorted[0]!.end };

  for (let i = 1; i < sorted.length; i += 1) {
    const next = sorted[i]!;
    // `>=` rather than `>`: two ranges that merely touch ([0,10] and [10,20])
    // describe continuous watching and must collapse, or a 10-minute lesson
    // watched straight through ends up as 60 adjacent heartbeat rows.
    if (next.start <= current.end) {
      current.end = Math.max(current.end, next.end);
    } else {
      merged.push(current);
      current = { start: next.start, end: next.end };
    }
  }
  merged.push(current);
  return merged;
}

/** Total distinct seconds covered by a set of intervals. */
export function coveredSeconds(intervals: Interval[]): number {
  return mergeIntervals(intervals).reduce((total, i) => total + (i.end - i.start), 0);
}

/** Covered seconds as a fraction of the media duration, clamped to [0, 1]. */
export function coverageRatio(intervals: Interval[], duration: number): number {
  if (!isFiniteNumber(duration) || duration <= 0) return 0;
  return Math.min(1, coveredSeconds(intervals) / duration);
}

/**
 * Whether the lesson counts as watched.
 *
 * The threshold is below 1 because the last seconds of a video are credits and
 * an exact-equality rule would leave students permanently at 99%: media
 * durations are floats and the player never reports the final frame.
 */
export function isLessonComplete(
  intervals: Interval[],
  duration: number,
  threshold: number = DEFAULT_COMPLETION_THRESHOLD,
): boolean {
  if (!isFiniteNumber(duration) || duration <= 0) return false;
  return coverageRatio(intervals, duration) >= threshold;
}

export interface ApplyHeartbeatInput {
  /** Intervals already stored for this student and lesson. */
  stored: Interval[];
  /** Intervals the player is reporting now. */
  reported: Interval[];
  /** Media duration in seconds, from ffprobe at transcode time. */
  duration: number;
  /**
   * Seconds of wall-clock since this student's previous heartbeat for this
   * lesson. `null` on the very first beat.
   */
  elapsedSinceLastBeat: number | null;
  threshold?: number;
}

export interface ApplyHeartbeatResult {
  intervals: Interval[];
  secondsWatched: number;
  coverage: number;
  completed: boolean;
  /** Reported seconds that were refused, for the anti-cheat log line. */
  rejectedSeconds: number;
}

/**
 * Playback drifts slightly ahead of wall-clock (buffered playback, a slow
 * heartbeat round trip, a 1.0x rate that is really 1.02x), so the budget gets
 * headroom. Without it a student watching normally would occasionally have a
 * legitimate second refused.
 */
export const ELAPSED_TOLERANCE = 1.25;
/** Floor on the budget, so a fast pair of beats does not clamp to nothing. */
export const MIN_ELAPSED_BUDGET_SECONDS = 15;

/**
 * The whole server-side progress rule, in one pure function.
 *
 * Three defences, in order:
 *
 *  1. Every reported interval is clamped into `[0, duration]`, so no amount of
 *     creative arithmetic on the client can claim more media than exists.
 *  2. The total *new* coverage in one beat is capped at the wall-clock elapsed
 *     since that student's previous beat (times a tolerance). This is what
 *     kills the "POST one interval of [0, 600] and finish instantly" shortcut:
 *     honest playback cannot cover ten minutes in ten seconds, so an attacker
 *     is reduced to actually waiting out the video.
 *  3. Coverage is the union, so replaying the same range a thousand times adds
 *     nothing.
 *
 * The cap is applied to *new* coverage rather than to raw reported length on
 * purpose: a client that re-reports an already-watched range (which the player
 * does after a reconnect) must not be penalised for it.
 */
export function applyHeartbeat(input: ApplyHeartbeatInput): ApplyHeartbeatResult {
  const { stored, reported, duration, elapsedSinceLastBeat, threshold } = input;

  const before = mergeIntervals(stored);
  const beforeSeconds = coveredSeconds(before);

  const clamped = reported
    .map((interval) => sanitizeInterval(interval, duration))
    .filter((interval): interval is Interval => interval !== null);

  let candidate = mergeIntervals([...before, ...clamped]);
  let candidateSeconds = coveredSeconds(candidate);
  let rejectedSeconds = 0;

  if (elapsedSinceLastBeat !== null && isFiniteNumber(elapsedSinceLastBeat)) {
    const budget = Math.max(
      MIN_ELAPSED_BUDGET_SECONDS,
      Math.max(0, elapsedSinceLastBeat) * ELAPSED_TOLERANCE,
    );
    const gained = candidateSeconds - beforeSeconds;
    if (gained > budget) {
      // Over budget: keep what was already there and take only as much of the
      // new coverage as the clock allows, in playback order. Truncating the
      // *last* accepted interval rather than dropping the whole beat means a
      // borderline-honest client still makes progress.
      rejectedSeconds = gained - budget;
      candidate = takeBudgeted(before, clamped, budget);
      candidateSeconds = coveredSeconds(candidate);
    }
  }

  return {
    intervals: candidate,
    secondsWatched: candidateSeconds,
    coverage: duration > 0 ? Math.min(1, candidateSeconds / duration) : 0,
    completed: isLessonComplete(candidate, duration, threshold),
    rejectedSeconds,
  };
}

/**
 * Add reported intervals to the stored set until `budget` seconds of new
 * coverage have been granted, truncating the interval that crosses the line.
 */
function takeBudgeted(stored: Interval[], reported: Interval[], budget: number): Interval[] {
  let accumulated = mergeIntervals(stored);
  let spent = 0;
  const ordered = [...reported].sort((a, b) => a.start - b.start);

  for (const interval of ordered) {
    if (spent >= budget) break;
    const withIt = mergeIntervals([...accumulated, interval]);
    const gain = coveredSeconds(withIt) - coveredSeconds(accumulated);
    if (gain <= 0) {
      // Fully covered already: free, and worth keeping so the merge stays tidy.
      accumulated = withIt;
      continue;
    }
    if (spent + gain <= budget) {
      accumulated = withIt;
      spent += gain;
      continue;
    }
    // Partial: shorten from the end, which is the direction playback grows in.
    const remaining = budget - spent;
    const truncated = { start: interval.start, end: interval.start + remaining };
    if (truncated.end - truncated.start >= MIN_INTERVAL_SECONDS) {
      accumulated = mergeIntervals([...accumulated, truncated]);
    }
    spent = budget;
  }
  return accumulated;
}

const CENTISECONDS = 100;

/**
 * Snap a value that is already on a centisecond boundary back onto it.
 *
 * `1.24 * 100` is `124.00000000000001` in IEEE 754, so a plain
 * `Math.ceil(x * 100) / 100` promotes an already-rounded 1.24 to 1.25, then to
 * 1.26, and a lesson's stored progress creeps forward every time it is saved.
 * The tolerance is relative, because the absolute error grows with the
 * magnitude and a two-hour lecture has values in the thousands.
 *
 * Returns null when the value genuinely sits between boundaries, in which case
 * the caller rounds in its own direction.
 */
function snapToCentisecond(value: number): number | null {
  const scaled = value * CENTISECONDS;
  const nearest = Math.round(scaled);
  const tolerance = 1e-9 * Math.max(1, Math.abs(scaled));
  return Math.abs(scaled - nearest) < tolerance ? nearest : null;
}

function ceilCentisecond(value: number): number {
  return (snapToCentisecond(value) ?? Math.ceil(value * CENTISECONDS)) / CENTISECONDS;
}

function floorCentisecond(value: number): number {
  return (snapToCentisecond(value) ?? Math.floor(value * CENTISECONDS)) / CENTISECONDS;
}

/** Storage shape: compact pairs, so a long lesson stays a small JSON column. */
export function toStored(intervals: Interval[]): [number, number][] {
  // Rounded to centiseconds. Full float precision serialises 17 digits per
  // number for accuracy nobody can perceive.
  //
  // The rounding is inward (start up, end down) so a round-trip can only ever
  // lose up to 20ms per interval, never invent coverage the student did not
  // have. It is idempotent on already-rounded values, so re-saving the same
  // progress a hundred times does not erode it.
  return intervals
    .map((i): [number, number] => [ceilCentisecond(i.start), floorCentisecond(i.end)])
    .filter(([start, end]) => end > start);
}
