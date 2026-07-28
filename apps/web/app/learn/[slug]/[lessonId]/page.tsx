import type { CourseDetail, LessonPlayback } from '@lms/shared/client';
import Link from 'next/link';
import { notFound, redirect } from 'next/navigation';
import { LessonView } from '../../../../components/lesson-view';
import { ApiError, apiFetch, browserToken, optionalApiFetch } from '../../../../lib/api';
import { PUBLIC_API_BASE_URL } from '../../../../lib/config';

export default async function LearnPage({
  params,
}: {
  params: { slug: string; lessonId: string };
}) {
  const token = await browserToken();
  if (!token) redirect(`/login`);

  let course: CourseDetail;
  let lesson: LessonPlayback;
  try {
    [course, lesson] = await Promise.all([
      optionalApiFetch<CourseDetail>(`/courses/${params.slug}`),
      apiFetch<LessonPlayback>(`/lessons/${params.lessonId}/playback`),
    ]);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    if (error instanceof ApiError && error.status === 403) {
      return (
        <main className="container">
          <h1>Not available</h1>
          <p className="notice" data-testid="access-denied">
            {error.message}
          </p>
          <p>
            <Link href={`/courses/${params.slug}`}>Back to the course</Link>
          </p>
        </main>
      );
    }
    throw error;
  }

  const completed = new Set(course.enrollment?.completedLessonIds ?? []);
  const allLessons = course.modules.flatMap((module) => module.lessons);
  const index = allLessons.findIndex((entry) => entry.id === params.lessonId);
  const next = index >= 0 ? allLessons[index + 1] : undefined;

  return (
    <main className="container-wide">
      <p className="mono muted">
        <Link href={`/courses/${course.slug}`}>{course.title}</Link>
      </p>
      <h1>{lesson.title}</h1>

      <div className="player-layout">
        <LessonView
          lesson={lesson}
          token={token}
          apiBaseUrl={PUBLIC_API_BASE_URL}
          nextHref={next ? `/learn/${course.slug}/${next.id}` : null}
        />

        <aside>
          <div className="syllabus" style={{ marginTop: 0 }} data-testid="lesson-nav">
            {course.modules.map((module) => (
              <section key={module.id} className="syllabus-module">
                <header>
                  <span>{module.title}</span>
                </header>
                {module.lessons.map((entry) => (
                  <div
                    key={entry.id}
                    className={`lesson-row${entry.id === params.lessonId ? ' current' : ''}`}
                  >
                    <span
                      className={`lesson-state${completed.has(entry.id) ? ' done' : ''}`}
                      aria-hidden="true"
                    />
                    <Link href={`/learn/${course.slug}/${entry.id}`}>{entry.title}</Link>
                  </div>
                ))}
              </section>
            ))}
          </div>
        </aside>
      </div>
    </main>
  );
}
