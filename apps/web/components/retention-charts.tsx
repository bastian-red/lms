'use client';

import { Area, AreaChart, CartesianGrid, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';

interface LessonAnalytics {
  id: string;
  title: string;
  durationSeconds: number;
  engagement: {
    starters: number;
    finishers: number;
    averageCoverage: number;
    biggestDropAtSeconds: number | null;
  };
  curve: { fromSeconds: number; toSeconds: number; watchers: number; retention: number }[];
}

/**
 * The retention curve, per video lesson.
 *
 * An area chart rather than bars: retention is a continuous quantity over time,
 * and the shape of the fall is the information. Y is pinned to 0-100 so two
 * lessons are visually comparable; auto-scaling would make a lesson that loses
 * 5% look like one that loses 80%.
 *
 * Monochrome, matching the rest of the interface. The one accent is reserved for
 * the drop-off marker, which is the only thing here that asks for action.
 */
export function RetentionCharts({ lessons }: { lessons: LessonAnalytics[] }) {
  if (lessons.length === 0) {
    return <p className="empty">No video lessons to measure yet</p>;
  }

  return (
    <div data-testid="retention-charts">
      {lessons.map((lesson) => (
        <div key={lesson.id} className="chart-frame">
          <div className="chart-caption">
            {lesson.title} · {lesson.engagement.starters} started ·{' '}
            {lesson.engagement.finishers} finished ·{' '}
            {lesson.engagement.biggestDropAtSeconds !== null
              ? `sharpest drop at ${Math.round(lesson.engagement.biggestDropAtSeconds)}s`
              : 'audience held'}
          </div>
          <ResponsiveContainer width="100%" height={160}>
            <AreaChart
              data={lesson.curve.map((bucket) => ({
                at: Math.round(bucket.fromSeconds),
                retention: Math.round(bucket.retention * 100),
              }))}
              margin={{ top: 4, right: 16, left: 8, bottom: 4 }}
            >
              <CartesianGrid stroke="var(--border)" vertical={false} />
              <XAxis
                dataKey="at"
                stroke="var(--muted)"
                tick={{ fontSize: 10, fontFamily: 'var(--ff-mono)' }}
                tickFormatter={(value: number) => `${value}s`}
              />
              <YAxis
                domain={[0, 100]}
                stroke="var(--muted)"
                tick={{ fontSize: 10, fontFamily: 'var(--ff-mono)' }}
                tickFormatter={(value: number) => `${value}%`}
                width={38}
              />
              <Tooltip
                contentStyle={{
                  background: 'var(--panel)',
                  border: '1px solid var(--border-strong)',
                  borderRadius: 0,
                  fontFamily: 'var(--ff-mono)',
                  fontSize: 11,
                }}
                // Recharts types these as ReactNode, because a chart can be
                // fed anything; the data here is always a number.
                labelFormatter={(label) => `${String(label)}s in`}
                formatter={(value) => [`${String(value)}%`, 'still watching']}
              />
              <Area
                type="monotone"
                dataKey="retention"
                stroke="var(--text)"
                strokeWidth={1}
                fill="var(--panel-2)"
                isAnimationActive={false}
              />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      ))}
    </div>
  );
}
