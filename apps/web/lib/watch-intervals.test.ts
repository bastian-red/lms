import { describe, expect, it } from 'vitest';
import { drain, emptySampler, sample, type SamplerState } from './watch-intervals';

/** Feed a sequence of [position, playing] samples. */
function feed(steps: [number, boolean][]): SamplerState {
  return steps.reduce(
    (state, [position, playing]) => sample(state, position, playing),
    emptySampler(),
  );
}

describe('sample', () => {
  it('accumulates continuous playback into one run', () => {
    const state = feed([
      [0, true],
      [1, true],
      [2, true],
      [3, true],
    ]);
    expect(drain(state).intervals).toEqual([{ start: 0, end: 3 }]);
  });

  it('splits on a seek, which is the whole point', () => {
    // Drag from 0:02 to 9:50 and let it play. Reporting one interval here would
    // credit the entire lesson for four seconds of watching.
    const state = feed([
      [0, true],
      [1, true],
      [2, true],
      [590, true],
      [591, true],
      [592, true],
    ]);
    const { intervals } = drain(state);
    expect(intervals).toEqual([
      { start: 0, end: 2 },
      { start: 590, end: 592 },
    ]);
    const total = intervals.reduce((sum, i) => sum + (i.end - i.start), 0);
    expect(total).toBe(4);
  });

  it('closes the run while paused, so paused time is not watched time', () => {
    const state = feed([
      [0, true],
      [1, true],
      [2, true],
      [2, false],
      [2, false],
      [2, false],
    ]);
    expect(drain(state).intervals).toEqual([{ start: 0, end: 2 }]);
  });

  it('starts a fresh run after a pause rather than bridging it', () => {
    const state = feed([
      [0, true],
      [2, true],
      [2, false],
      [2, true],
      [4, true],
    ]);
    const { intervals } = drain(state);
    expect(intervals).toEqual([
      { start: 0, end: 2 },
      { start: 2, end: 4 },
    ]);
  });

  it('tolerates a throttled background tab without calling it a seek', () => {
    // A hidden tab fires the timer late; the position legitimately advances by
    // more than one sample. Splitting there would fragment every interval.
    const state = feed([
      [0, true],
      [2.5, true],
      [5, true],
    ]);
    expect(drain(state).intervals).toEqual([{ start: 0, end: 5 }]);
  });

  it('drops a sub-second run as seek noise', () => {
    // Scrubbing emits a flurry of these; keeping them would blow past the
    // server's 60-interval cap on a single beat.
    const state = feed([
      [10, true],
      [10.2, true],
      [400, true],
    ]);
    expect(drain(state).intervals).toEqual([]);
  });

  it('never produces a negative-length interval on a small rewind', () => {
    // A player correcting its own position can report a position slightly
    // behind the previous one.
    const state = feed([
      [10, true],
      [12, true],
      [11.5, true],
      [13, true],
    ]);
    for (const interval of drain(state).intervals) {
      expect(interval.end).toBeGreaterThanOrEqual(interval.start);
    }
  });

  it('ignores a NaN position instead of poisoning the run', () => {
    // `currentTime` is NaN before metadata loads.
    const state = feed([
      [Number.NaN, true],
      [0, true],
      [1, true],
    ]);
    expect(drain(state).intervals).toEqual([{ start: 0, end: 1 }]);
  });
});

describe('drain', () => {
  it('empties the pending list so the next beat does not resend', () => {
    const first = feed([
      [0, true],
      [2, true],
    ]);
    const { state } = drain(first);
    expect(drain(state).intervals).toEqual([]);
  });

  it('keeps the last position, so playback continues rather than restarting', () => {
    const first = feed([
      [0, true],
      [2, true],
    ]);
    const { state } = drain(first);
    const next = sample(state, 3, true);
    expect(drain(next).intervals).toEqual([{ start: 2, end: 3 }]);
  });

  it('returns nothing for a lesson that was never played', () => {
    expect(drain(emptySampler()).intervals).toEqual([]);
  });
});
