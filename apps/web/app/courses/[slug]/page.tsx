import type { CourseDetail } from '@lms/shared/client';
import Link from 'next/link';
import { notFound } from 'next/navigation';
import { auth } from '../../../auth';
import { CertificatePanel } from '../../../components/certificate-panel';
import { EnrollButton } from '../../../components/enroll-button';
import { ApiError, optionalApiFetch } from '../../../lib/api';

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

  return (
    <main className="container">
      <p className="mono muted">{course.instructor.name ?? 'Instructor'}</p>
      <h1>{course.title}</h1>
      <p>{course.description || course.summary}</p>

      <div className="course-meta" style={{ borderTop: 'none', paddingTop: 0 }}>
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
        <div style={{ marginTop: 24 }}>
          <div className="progress-line">
            <span>Your progress</span>
            <b data-testid="course-progress">{Math.round(course.enrollment.progress * 100)}%</b>
          </div>
          <div className="meter">
            <span style={{ width: `${course.enrollment.progress * 100}%` }} />
          </div>
        </div>
      ) : null}

      <p style={{ marginTop: 24 }}>
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

      <h2 style={{ marginTop: 40 }}>Syllabus</h2>
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
                  <span
                    className={`lesson-state${completed.has(lesson.id) ? ' done' : openable ? '' : ' locked'}`}
                    aria-hidden="true"
                  />
                  {openable ? (
                    <Link href={`/learn/${course.slug}/${lesson.id}`}>{lesson.title}</Link>
                  ) : (
                    <span style={{ flex: 1 }}>{lesson.title}</span>
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
