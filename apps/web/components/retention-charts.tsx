'use client';

import {
  Area,
  AreaChart,
  CartesianGrid,
  ReferenceLine,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

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

/** `95` -> `1:35`. Axis ticks in raw seconds stop being readable past a minute. */
function clock(seconds: number): string {
  const whole = Math.round(seconds);
  const minutes = Math.floor(whole / 60);
  return minutes === 0 ? `${whole}s` : `${minutes}:${String(whole % 60).padStart(2, '0')}`;
}

/**
 * The retention curve, per video lesson.
 *
 * ## Why this form
 *
 * Retention is one continuous quantity over time and the *shape of the fall* is
 * the information — where the audience leaves, not how many are left at the end.
 * That is an area chart. Bars would impose a categorical reading on a continuum,
 * and a table carries the numbers while losing the shape, which is why the table
 * is offered alongside rather than instead.
 *
 * ## Why the axis is pinned
 *
 * Y is fixed to 0–100 so two lessons are visually comparable. Auto-scaling is
 * the most common way a chart lies: a lesson that loses 5% and one that loses
 * 80% would draw the identical falling curve, and an instructor scanning a page
 * of them would read the two as the same problem.
 *
 * ## Why one colour
 *
 * One series, so there is nothing to tell apart and no legend to read — the
 * caption names it. The accent carries the curve, and the only second colour is
 * the warning marker at the sharpest drop, which is the one thing here that asks
 * for action. Reserving a status colour for status is what stops it quietly
 * becoming "series 2" later.
 *
 * ## Accessibility
 *
 * The marker is not colour alone: it is a dashed rule, and the same fact is
 * stated in words in the caption. Every curve has a table underneath it with the
 * same numbers, because a chart that a screen reader cannot read is a chart half
 * the audience does not have.
 */
export function RetentionCharts({ lessons }: { lessons: LessonAnalytics[] }) {
  if (lessons.length === 0) {
    return <p className="empty">No video lessons to measure yet</p>;
  }

  return (
    <div data-testid="retention-charts">
      {lessons.map((lesson) => {
        const data = lesson.curve.map((bucket) => ({
          at: Math.round(bucket.fromSeconds),
          retention: Math.round(bucket.retention * 100),
        }));
        const drop = lesson.engagement.biggestDropAtSeconds;

        return (
          <figure key={lesson.id} className="chart-frame">
            {/* A real <figcaption>, so the numbers a screen reader needs arrive
                before the graphic rather than being trapped inside it. The
                chart is deliberately *not* aria-hidden: Recharts makes its
                surface focusable for keyboard tooltips, and hiding a subtree
                that contains focusable elements is itself a WCAG failure
                (axe `aria-hidden-focus`). The table below carries the data. */}
            <figcaption className="chart-caption">
              {lesson.title} · {lesson.engagement.starters} started ·{' '}
              {lesson.engagement.finishers} finished ·{' '}
              {drop !== null ? `sharpest drop at ${clock(drop)}` : 'audience held'}
            </figcaption>

            <div>
              <ResponsiveContainer width="100%" height={170}>
                <AreaChart data={data} margin={{ top: 8, right: 16, left: 8, bottom: 4 }}>
                  {/* Recessive: horizontal rules only, so the eye reads the
                      curve and uses the grid to check a value rather than the
                      other way round. */}
                  <CartesianGrid stroke="var(--border)" vertical={false} />
                  <XAxis
                    dataKey="at"
                    stroke="var(--border-strong)"
                    tick={{ fontSize: 10, fontFamily: 'var(--ff-mono)', fill: 'var(--muted)' }}
                    tickFormatter={clock}
                  />
                  <YAxis
                    domain={[0, 100]}
                    ticks={[0, 50, 100]}
                    stroke="var(--border-strong)"
                    tick={{ fontSize: 10, fontFamily: 'var(--ff-mono)', fill: 'var(--muted)' }}
                    tickFormatter={(value: number) => `${value}%`}
                    width={38}
                  />
                  <Tooltip
                    cursor={{ stroke: 'var(--border-strong)', strokeWidth: 1 }}
                    contentStyle={{
                      background: 'var(--surface)',
                      border: '1px solid var(--border-strong)',
                      borderRadius: 'var(--radius)',
                      fontFamily: 'var(--ff-mono)',
                      fontSize: 11,
                      color: 'var(--text)',
                    }}
                    // Recharts types these as ReactNode, because a chart can be
                    // fed anything; the data here is always a number.
                    labelFormatter={(label) => `${clock(Number(label))} in`}
                    formatter={(value) => [`${String(value)}%`, 'still watching']}
                  />
                  {drop !== null && (
                    <ReferenceLine
                      x={Math.round(drop)}
                      stroke="var(--state-warn)"
                      strokeWidth={2}
                      strokeDasharray="4 3"
                    />
                  )}
                  <Area
                    type="monotone"
                    dataKey="retention"
                    stroke="var(--accent)"
                    strokeWidth={2}
                    fill="var(--accent)"
                    fillOpacity={0.14}
                    isAnimationActive={false}
                  />
                </AreaChart>
              </ResponsiveContainer>
            </div>

            {/* The table alternative. Collapsed so it does not compete with the
                chart, but in the DOM and reachable by keyboard. */}
            <details className="chart-table">
              <summary>Retention for {lesson.title} as a table</summary>
              <div className="table-wrap">
                <table>
                  <caption className="sr-only">
                    Percentage of viewers still watching {lesson.title} at each point
                  </caption>
                  <thead>
                    <tr>
                      <th scope="col">At</th>
                      <th scope="col" className="num">
                        Still watching
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {data.map((point) => (
                      <tr key={point.at}>
                        <td>{clock(point.at)}</td>
                        <td className="num">{point.retention}%</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </details>
          </figure>
        );
      })}
    </div>
  );
}
