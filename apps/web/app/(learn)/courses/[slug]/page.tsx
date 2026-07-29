import type { CourseDetail } from '@lms/shared/client';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { auth } from '../../../../auth';
import { CertificatePanel } from '../../../../components/certificate-panel';
import { EnrollButton } from '../../../../components/enroll-button';
import { ApiError, optionalApiFetch } from '../../../../lib/api';

function formatDuration(seconds: number): string {
  if (seconds <= 0) return '—';
  const total = Math.round(seconds);
  const minutes = Math.floor(total / 60);
  return `${minutes}:${String(total % 60).padStart(2, '0')}`;
}

export default async function CoursePage({ params }: { params: { slug: string } }) {
  let course: CourseDetail;
  try {
    course = await optionalApiFetch<CourseDetail>(`/courses/${params.slug}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) notFound();
    throw error;
  }

  const session = await auth();
  const enrolled =
    course.enrollment?.status === 'ACTIVE' || course.enrollment?.status === 'COMPLETED';
  const completed = new Set(course.enrollment?.completedLessonIds ?? []);
  const firstLesson = course.modules.flatMap((module) => module.lessons)[0];
  const totalLessons = course.modules.reduce((sum, module) => sum + module.lessons.length, 0);

  return (
    <main className="container">
      <p className="mono muted">{course.instructor.name ?? 'Instructor'}</p>
      <h1>{course.title}</h1>
      <p>{course.description || course.summary}</p>

      <div className="course-meta flush-top">
        <span>
          <strong>{course.lessonCount}</strong> lessons
        </span>
        <span>
          <strong>{formatDuration(course.totalDurationSeconds)}</strong> total
        </span>
        <span>
          <strong>{course.enrolledCount}</strong> enrolled
        </span>
      </div>

      {course.enrollment ? (
        <div className="course-progress">
          <div className="progress-line">
            <span>Your progress</span>
            <b data-testid="course-progress">{Math.round(course.enrollment.progress * 100)}%</b>
          </div>
          {/* role=progressbar so the value is announced. A bar that is only
              drawn tells a screen-reader user nothing at all. */}
          <div
            className="meter"
            role="progressbar"
            aria-valuenow={Math.round(course.enrollment.progress * 100)}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label="Course progress"
          >
            <span style={{ width: `${course.enrollment.progress * 100}%` }} />
          </div>
          {/* The same fact in words. A percentage answers "how far", this
              answers "how much is left", which is the question people ask. */}
          <p className="progress-detail" data-testid="progress-detail">
            {completed.size} of {totalLessons} {totalLessons === 1 ? 'lesson' : 'lessons'} complete
          </p>
        </div>
      ) : null}

      <p className="mt-6">
        {enrolled ? (
          firstLesson ? (
            <Link
              href={`/learn/${course.slug}/${firstLesson.id}`}
              className="btn btn-primary"
              data-testid="continue"
            >
              Continue
            </Link>
          ) : null
        ) : session ? (
          <EnrollButton courseId={course.id} slug={course.slug} />
        ) : (
          <Link href="/login" className="btn btn-primary">
            Sign in to enroll
          </Link>
        )}
      </p>

      {course.enrollment ? (
        <CertificatePanel
          courseId={course.id}
          existingSerial={course.enrollment.certificateSerial}
        />
      ) : null}

      <h2 className="section-head">Syllabus</h2>
      <div className="syllabus" data-testid="syllabus">
        {course.modules.map((module) => (
          <section key={module.id} className="syllabus-module">
            <header>
              <span>{module.title}</span>
              <span>{module.lessons.length} lessons</span>
            </header>
            {module.lessons.map((lesson) => {
              const openable = enrolled || lesson.isPreview;
              return (
                <div key={lesson.id} className="lesson-row">
                  {/* The marker is decorative, so it stays aria-hidden — but the
                      state it encodes is not, and a sighted user reads it off a
                      tick or a dashed ring. The visually-hidden word is that
                      same information for everyone else. */}
                  <span
                    className={`lesson-state${completed.has(lesson.id) ? ' done' : openable ? '' : ' locked'}`}
                    aria-hidden="true"
                  />
                  <span className="sr-only">
                    {completed.has(lesson.id)
                      ? 'Completed:'
                      : openable
                        ? 'Not started:'
                        : 'Locked, enroll to open:'}
                  </span>
                  {openable ? (
                    <Link href={`/learn/${course.slug}/${lesson.id}`}>{lesson.title}</Link>
                  ) : (
                    <span className="grow">{lesson.title}</span>
                  )}
                  {lesson.isPreview ? <span className="badge">Preview</span> : null}
                  {lesson.kind === 'QUIZ' ? (
                    <span className="badge">Quiz</span>
                  ) : (
                    <span className="lesson-time">{formatDuration(lesson.durationSeconds)}</span>
                  )}
                </div>
              );
            })}
          </section>
        ))}
      </div>
    </main>
  );
}
