import { describe, expect, it } from 'vitest';
import {
  applyHeartbeat,
  coveredSeconds,
  coverageRatio,
  isLessonComplete,
  MIN_ELAPSED_BUDGET_SECONDS,
  mergeIntervals,
  parseIntervals,
  sanitizeInterval,
  toStored,
  type Interval,
} from './intervals';

const i = (start: number, end: number): Interval => ({ start, end });

describe('mergeIntervals', () => {
  it('returns an empty set for no input', () => {
    expect(mergeIntervals([])).toEqual([]);
  });

  it('collapses overlapping ranges', () => {
    expect(mergeIntervals([i(0, 10), i(5, 20)])).toEqual([i(0, 20)]);
  });

  it('collapses ranges that merely touch', () => {
    // Continuous playback reported by two consecutive heartbeats. Left
    // unmerged, a ten minute lesson becomes sixty adjacent rows.
    expect(mergeIntervals([i(0, 10), i(10, 20)])).toEqual([i(0, 20)]);
  });

  it('keeps genuinely disjoint ranges apart', () => {
    expect(mergeIntervals([i(0, 10), i(30, 40)])).toEqual([i(0, 10), i(30, 40)]);
  });

  it('handles out-of-order input, which the network guarantees', () => {
    expect(mergeIntervals([i(30, 40), i(0, 10), i(8, 32)])).toEqual([i(0, 40)]);
  });

  it('swallows a range fully contained in another', () => {
    expect(mergeIntervals([i(0, 100), i(20, 30)])).toEqual([i(0, 100)]);
  });

  it('drops zero-length and reversed ranges', () => {
    expect(mergeIntervals([i(5, 5), i(20, 10)])).toEqual([]);
  });
});

describe('coveredSeconds', () => {
  it('does not double count a replayed range', () => {
    const replayed = Array.from({ length: 100 }, () => i(0, 30));
    expect(coveredSeconds(replayed)).toBe(30);
  });

  it('sums disjoint ranges', () => {
    expect(coveredSeconds([i(0, 10), i(50, 65)])).toBe(25);
  });
});

describe('sanitizeInterval', () => {
  it('clamps an end past the media duration', () => {
    expect(sanitizeInterval(i(0, 99_999), 600)).toEqual(i(0, 600));
  });

  it('clamps a negative start', () => {
    expect(sanitizeInterval(i(-500, 30), 600)).toEqual(i(0, 30));
  });

  it('rejects a range shorter than the minimum', () => {
    expect(sanitizeInterval(i(10, 10.1), 600)).toBeNull();
  });

  it('rejects a reversed range', () => {
    expect(sanitizeInterval(i(90, 30), 600)).toBeNull();
  });

  it('rejects anything when the duration is unknown', () => {
    expect(sanitizeInterval(i(0, 30), 0)).toBeNull();
  });
});

describe('isLessonComplete', () => {
  it('is false below the threshold', () => {
    expect(isLessonComplete([i(0, 500)], 600)).toBe(false);
  });

  it('is true at the threshold', () => {
    expect(isLessonComplete([i(0, 540)], 600)).toBe(true);
  });

  it('never completes on a zero duration', () => {
    expect(isLessonComplete([i(0, 600)], 0)).toBe(false);
  });

  it('honours an explicit threshold', () => {
    expect(isLessonComplete([i(0, 300)], 600, 0.5)).toBe(true);
  });
});

describe('applyHeartbeat — the anti-cheat rule', () => {
  const duration = 600;

  it('seeking to the end credits ~2 seconds, not the whole lesson', () => {
    // The headline case. A student drags the scrubber to the last two seconds
    // and lets it play out. Tracking `currentTime` would call that 100%.
    const result = applyHeartbeat({
      stored: [],
      reported: [i(duration - 2, duration)],
      duration,
      elapsedSinceLastBeat: null,
    });

    expect(result.secondsWatched).toBeCloseTo(2, 5);
    expect(result.coverage).toBeCloseTo(2 / 600, 5);
    expect(result.completed).toBe(false);
  });

  it('refuses a fabricated full-length interval posted in one beat', () => {
    // The direct attack: claim the entire video ten seconds after the last
    // heartbeat. The wall-clock budget is what makes it impossible.
    const result = applyHeartbeat({
      stored: [],
      reported: [i(0, duration)],
      duration,
      elapsedSinceLastBeat: 10,
    });

    expect(result.secondsWatched).toBeLessThanOrEqual(MIN_ELAPSED_BUDGET_SECONDS);
    expect(result.completed).toBe(false);
    expect(result.rejectedSeconds).toBeGreaterThan(500);
  });

  it('clamps an interval that runs past the end of the media', () => {
    const result = applyHeartbeat({
      stored: [],
      reported: [i(0, 10_000)],
      duration,
      elapsedSinceLastBeat: 100_000,
    });
    expect(result.secondsWatched).toBe(duration);
  });

  it('accepts honest playback at the reported rate', () => {
    const result = applyHeartbeat({
      stored: [i(0, 100)],
      reported: [i(100, 110)],
      duration,
      elapsedSinceLastBeat: 10,
    });
    expect(result.secondsWatched).toBeCloseTo(110, 5);
    expect(result.rejectedSeconds).toBe(0);
  });

  it('does not penalise a client that re-reports an already-watched range', () => {
    // A reconnecting player resends its buffer. That is not new coverage, so it
    // must not consume the wall-clock budget.
    const result = applyHeartbeat({
      stored: [i(0, 300)],
      reported: [i(0, 300), i(300, 305)],
      duration,
      elapsedSinceLastBeat: 5,
    });
    expect(result.secondsWatched).toBeCloseTo(305, 5);
    expect(result.rejectedSeconds).toBe(0);
  });

  it('lets an honest student finish the lesson', () => {
    // Sixty heartbeats, ten seconds of playback each, ten seconds apart.
    let stored: Interval[] = [];
    let result = applyHeartbeat({
      stored,
      reported: [],
      duration,
      elapsedSinceLastBeat: null,
    });
    for (let beat = 0; beat < 60; beat += 1) {
      result = applyHeartbeat({
        stored,
        reported: [i(beat * 10, beat * 10 + 10)],
        duration,
        elapsedSinceLastBeat: 10,
      });
      stored = result.intervals;
    }
    expect(result.secondsWatched).toBe(600);
    expect(result.completed).toBe(true);
    expect(result.rejectedSeconds).toBe(0);
  });

  it('grants partial credit when a beat overshoots the budget', () => {
    // Not all-or-nothing: an overshooting client still banks what the clock
    // allows, so a slightly-fast player is not stuck at zero forever.
    const result = applyHeartbeat({
      stored: [],
      reported: [i(0, 400)],
      duration,
      elapsedSinceLastBeat: 60,
    });
    expect(result.secondsWatched).toBeCloseTo(75, 5); // 60 * 1.25
    expect(result.rejectedSeconds).toBeCloseTo(325, 5);
  });

  it('caps the very first beat too', () => {
    // `elapsedSinceLastBeat: null` means no previous beat, so there is no clock
    // to measure against and only the duration clamp applies. The client is
    // therefore trusted exactly once — which is why the player posts its first
    // beat within seconds of play, and why a single beat can never exceed the
    // media length.
    const result = applyHeartbeat({
      stored: [],
      reported: [i(0, duration)],
      duration,
      elapsedSinceLastBeat: null,
    });
    expect(result.secondsWatched).toBe(duration);
  });

  it('is monotonic: coverage never decreases across beats', () => {
    let stored: Interval[] = [i(0, 200)];
    const before = coveredSeconds(stored);
    for (const reported of [[i(50, 60)], [], [i(-100, -50)], [i(700, 900)]]) {
      const result = applyHeartbeat({ stored, reported, duration, elapsedSinceLastBeat: 10 });
      expect(coveredSeconds(result.intervals)).toBeGreaterThanOrEqual(before);
      stored = result.intervals;
    }
  });
});

describe('parseIntervals', () => {
  it('reads the compact stored pair form', () => {
    expect(parseIntervals([[0, 10]])).toEqual([i(0, 10)]);
  });

  it('reads the object form', () => {
    expect(parseIntervals([{ start: 0, end: 10 }])).toEqual([i(0, 10)]);
  });

  it('survives a corrupt column instead of throwing', () => {
    // A progress row written by hand or by an older version must not 500 the
    // lesson page.
    expect(parseIntervals(null)).toEqual([]);
    expect(parseIntervals('nonsense')).toEqual([]);
    expect(parseIntervals([1, 2, 3])).toEqual([]);
    expect(parseIntervals([{ start: 'a', end: 'b' }])).toEqual([]);
    expect(parseIntervals([[0, Number.NaN]])).toEqual([]);
  });
});

describe('toStored', () => {
  it('rounds inward so a round trip cannot invent coverage', () => {
    const [pair] = toStored([i(1.239, 9.871)]);
    expect(pair).toEqual([1.24, 9.87]);
    expect(pair![1] - pair![0]).toBeLessThan(9.871 - 1.239);
  });

  it('is idempotent, so repeated saves do not erode progress', () => {
    let intervals = [i(1.239, 9.871)];
    const after = (n: number): number => {
      for (let round = 0; round < n; round += 1) {
        intervals = parseIntervals(toStored(intervals));
      }
      return coveredSeconds(intervals);
    };
    const once = after(1);
    expect(after(50)).toBe(once);
  });

  it('drops an interval that rounds away to nothing', () => {
    expect(toStored([i(1.001, 1.002)])).toEqual([]);
  });
});

describe('coverageRatio', () => {
  it('is 0 for an unknown duration rather than Infinity', () => {
    expect(coverageRatio([i(0, 10)], 0)).toBe(0);
  });

  it('never exceeds 1', () => {
    expect(coverageRatio([i(0, 10_000)], 600)).toBe(1);
  });
});
