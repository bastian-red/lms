import type { CourseSummary } from '@lms/shared/client';
import Link from 'next/link';
import { cachedApiFetch } from '../../lib/api';

/**
 * The catalogue.
 *
 * Rendered on demand, not statically. `Nav` sits in the root layout and reads
 * the session with `auth()`, which touches cookies, so every route in the app
 * is dynamic — `next build` marks even `/_not-found` as `ƒ`. That is a
 * deliberate trade: a server-read session means the nav paints correct on the
 * first byte instead of flickering from logged-out to logged-in, and it costs
 * static generation of the pages below it.
 *
 * What still holds is the *data* cache. `cachedApiFetch` tags this fetch, so
 * the API response is reused for 60s across visitors and publishing a course
 * invalidates exactly it via `revalidateTag('courses')`. The page re-renders
 * per request; it does not re-query the API per request.
 */

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '—';
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

export default async function CatalogPage() {
  const courses = await cachedApiFetch<CourseSummary[]>('/courses', ['courses']);

  return (
    <main className="container">
      <section className="hero">
        {/* The eyebrow is content and lives in the markup. It used to be a CSS
            `content: '// SHOP'` inherited from an e-commerce template, which
            rendered literally above the heading on this page. */}
        <span className="eyebrow">// Courses</span>
        <h1>Learn it properly</h1>
        <p>
          Adaptive HLS with AES-128 encrypted segments, keys handed out per request, and progress
          measured from what you actually watched.
        </p>
      </section>

      {courses.length === 0 ? (
        <p className="empty">No published courses yet</p>
      ) : (
        <div className="courses" data-testid="course-list">
          {courses.map((course) => (
            <article key={course.id} className="course-card">
              <h3>
                <Link href={`/courses/${course.slug}`}>{course.title}</Link>
              </h3>
              <p>{course.summary}</p>
              <div className="course-meta">
                <span>
                  <strong>{course.lessonCount}</strong> lessons
                </span>
                <span>
                  <strong>{formatDuration(course.totalDurationSeconds)}</strong> video
                </span>
                <span>
                  <strong>{course.enrolledCount}</strong> enrolled
                </span>
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
