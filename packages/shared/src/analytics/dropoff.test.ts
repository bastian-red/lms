import { describe, expect, it } from 'vitest';
import type { Interval } from '../progress/intervals';
import { dropOffCurve, lessonEngagement } from './dropoff';

const i = (start: number, end: number): Interval => ({ start, end });

describe('dropOffCurve', () => {
  it('returns nothing for an unknown duration', () => {
    expect(dropOffCurve([[i(0, 10)]], 0)).toEqual([]);
  });

  it('reports full retention when everyone watched everything', () => {
    const curve = dropOffCurve([[i(0, 100)], [i(0, 100)]], 100, 4);
    expect(curve).toHaveLength(4);
    expect(curve.every((bucket) => bucket.retention === 1)).toBe(true);
  });

  it('shows the cliff where half the cohort stops', () => {
    // One student watches it all, one leaves at the halfway mark.
    const curve = dropOffCurve([[i(0, 100)], [i(0, 50)]], 100, 4);
    expect(curve.map((b) => b.watchers)).toEqual([2, 2, 1, 1]);
    expect(curve[2]!.retention).toBe(0.5);
  });

  it('excludes students who never pressed play from the denominator', () => {
    // Including them would flatten the curve and hide the real drop-off.
    const curve = dropOffCurve([[i(0, 100)], []], 100, 2);
    expect(curve[0]!.retention).toBe(1);
  });

  it('counts a partially watched bucket as watched', () => {
    // Any overlap is evidence the student was still there.
    const curve = dropOffCurve([[i(0, 26)]], 100, 4);
    expect(curve[1]!.watchers).toBe(1);
  });

  it('ends the last bucket exactly at the duration', () => {
    // A float-multiplied bound would land a hair short and report 99% for a
    // fully watched lesson.
    const curve = dropOffCurve([[i(0, 99.7)]], 99.7, 7);
    expect(curve.at(-1)!.toSeconds).toBe(99.7);
    expect(curve.at(-1)!.retention).toBe(1);
  });

  it('handles an empty cohort without dividing by zero', () => {
    const curve = dropOffCurve([], 100, 4);
    expect(curve.every((bucket) => bucket.retention === 0)).toBe(true);
  });

  it('forces at least one bucket', () => {
    expect(dropOffCurve([[i(0, 100)]], 100, 0)).toHaveLength(1);
  });
});

describe('lessonEngagement', () => {
  it('separates starters from finishers', () => {
    const result = lessonEngagement([[i(0, 100)], [i(0, 20)], []], 100);
    expect(result.starters).toBe(2);
    expect(result.finishers).toBe(1);
    expect(result.averageCoverage).toBeCloseTo(0.6, 5);
  });

  it('names the point where the lesson loses half its audience', () => {
    // Ten students; nine leave at 20% in.
    const cohort = [[i(0, 100)], ...Array.from({ length: 9 }, () => [i(0, 20)])];
    const result = lessonEngagement(cohort, 100, 0.9, 10);
    expect(result.biggestDropAtSeconds).toBe(20);
  });

  it('reports no drop when the audience holds', () => {
    const result = lessonEngagement([[i(0, 100)], [i(0, 100)]], 100, 0.9, 10);
    expect(result.biggestDropAtSeconds).toBeNull();
  });

  it('returns zeroes for an unknown duration instead of NaN', () => {
    expect(lessonEngagement([[i(0, 10)]], 0)).toEqual({
      starters: 0,
      finishers: 0,
      averageCoverage: 0,
      biggestDropAtSeconds: null,
    });
  });
});
