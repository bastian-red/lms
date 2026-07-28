import type { CourseSummary } from '@lms/shared/client';
import Link from 'next/link';
import { cachedApiFetch } from '../lib/api';

/**
 * The catalogue.
 *
 * ISR with a tag: the list changes when an instructor publishes, which is rare,
 * so serving a cached page and revalidating on the tag beats hitting the API on
 * every visit.
 */
export const revalidate = 60;

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
