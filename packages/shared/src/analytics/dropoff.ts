import { coveredSeconds, mergeIntervals, type Interval } from '../progress/intervals';

/**
 * Instructor analytics over watch intervals.
 *
 * The question an instructor actually asks is "where do people stop watching",
 * and the answer is a retention curve: for each slice of the video, what share
 * of the students who started it were still watching there. Pure arithmetic
 * over the same merged intervals progress uses, so the chart and the progress
 * bar can never disagree.
 */

export interface DropOffBucket {
  /** Bucket start, in seconds. */
  fromSeconds: number;
  /** Bucket end, in seconds. */
  toSeconds: number;
  /** Students with any coverage inside this bucket. */
  watchers: number;
  /** `watchers` as a share of the students who watched any of the lesson. */
  retention: number;
}

export const DEFAULT_BUCKETS = 20;

/**
 * Whether a student's merged intervals cover any part of `[from, to)`.
 *
 * Any overlap counts, not full coverage: a student who watched half of a bucket
 * was demonstrably still there, and requiring the whole slice would report a
 * cliff at every skipped credit sequence.
 */
function touchesBucket(intervals: Interval[], from: number, to: number): boolean {
  return intervals.some((interval) => interval.start < to && interval.end > from);
}

/**
 * Build the retention curve.
 *
 * The denominator is students with *any* coverage, not everyone enrolled.
 * Including people who never pressed play would flatten every curve toward zero
 * and hide the thing being measured, which is where the people who did start
 * gave up.
 */
export function dropOffCurve(
  intervalsPerStudent: Interval[][],
  duration: number,
  buckets: number = DEFAULT_BUCKETS,
): DropOffBucket[] {
  if (!Number.isFinite(duration) || duration <= 0) return [];
  const bucketCount = Math.max(1, Math.floor(buckets));
  const width = duration / bucketCount;

  const merged = intervalsPerStudent.map((intervals) => mergeIntervals(intervals));
  const starters = merged.filter((intervals) => coveredSeconds(intervals) > 0);

  return Array.from({ length: bucketCount }, (_, index) => {
    const fromSeconds = index * width;
    // The last bucket ends exactly at `duration` rather than at a value a float
    // multiplication drifted past it, so a fully watched lesson reads 100%.
    const toSeconds = index === bucketCount - 1 ? duration : (index + 1) * width;
    const watchers = starters.filter((intervals) =>
      touchesBucket(intervals, fromSeconds, toSeconds),
    ).length;
    return {
      fromSeconds,
      toSeconds,
      watchers,
      retention: starters.length > 0 ? watchers / starters.length : 0,
    };
  });
}

export interface LessonEngagement {
  /** Students with any coverage. */
  starters: number;
  /** Students whose coverage reached the completion threshold. */
  finishers: number;
  /** Mean coverage across starters, 0-1. */
  averageCoverage: number;
  /**
   * The bucket where retention first falls below half of the first bucket, or
   * null when the lesson never loses half its audience. This is the single
   * number an instructor can act on.
   */
  biggestDropAtSeconds: number | null;
}

export function lessonEngagement(
  intervalsPerStudent: Interval[][],
  duration: number,
  threshold = 0.9,
  buckets: number = DEFAULT_BUCKETS,
): LessonEngagement {
  if (!Number.isFinite(duration) || duration <= 0) {
    return { starters: 0, finishers: 0, averageCoverage: 0, biggestDropAtSeconds: null };
  }
  const coverages = intervalsPerStudent
    .map((intervals) => coveredSeconds(intervals) / duration)
    .filter((coverage) => coverage > 0);

  const curve = dropOffCurve(intervalsPerStudent, duration, buckets);
  const first = curve[0]?.retention ?? 0;
  const dropped = curve.find((bucket) => bucket.retention < first / 2);

  return {
    starters: coverages.length,
    finishers: coverages.filter((coverage) => coverage >= threshold).length,
    averageCoverage:
      coverages.length > 0 ? coverages.reduce((a, b) => a + b, 0) / coverages.length : 0,
    biggestDropAtSeconds: dropped ? dropped.fromSeconds : null,
  };
}
