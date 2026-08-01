/**
 * Course progress, as a ring.
 *
 * On a list of enrolled courses, momentum is the thing a student is scanning
 * for — "which of these am I nearly done with" — and a horizontal bar answers
 * that only after you have read the label beside it. A ring answers it at a
 * glance, and it costs one element: a conic-gradient with a punched-out centre,
 * no SVG and no charting library.
 *
 * Colour is not the signal. The percentage is inside the ring as text, and the
 * accessible name spells it out, so the component survives greyscale, colour
 * blindness and a screen reader. `role="img"` is what stops assistive tech
 * reading the bare number twice.
 */
export function ProgressRing({ progress }: { progress: number }) {
  // Clamp rather than trust: a rounding error upstream that yields 1.02 would
  // otherwise paint a conic-gradient past 360deg, which renders as an empty
  // ring — the exact opposite of what it means.
  const pct = Math.round(Math.min(1, Math.max(0, progress)) * 100);
  const complete = pct === 100;
  return (
    <div
      className={`ring${complete ? ' complete' : ''}`}
      // --pct is data, so it belongs on the element rather than in a stylesheet
      // that would need one rule per possible value.
      style={{ '--pct': pct } as React.CSSProperties}
      role="img"
      aria-label={complete ? 'Course complete' : `${pct} percent complete`}
      data-testid="progress-ring"
    >
      <span aria-hidden="true">{complete ? '✓' : pct}</span>
    </div>
  );
}
