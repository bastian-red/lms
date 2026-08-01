import type { CourseSummary, EnrollmentSummary } from '@lms/shared/client';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '../../../../auth';
import { apiFetch } from '../../../../lib/api';
import { ProgressRing } from '../../../../components/progress-ring';

type Enrolled = CourseSummary & { enrollment: EnrollmentSummary };

export default async function MyCoursesPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');

  const courses = await apiFetch<Enrolled[]>('/me/courses');

  return (
    <main className="container">
      <h1>My courses</h1>
      {courses.length === 0 ? (
        <p className="empty">
          Nothing yet — <Link href="/">browse the catalog</Link>
        </p>
      ) : (
        <div className="courses" data-testid="my-courses">
          {courses.map((course) => (
            <article key={course.id} className="course-card">
              {/* The ring leads. On a list of enrolled courses the question is
                  "which am I nearly done with", and a bar answers that only
                  after the label beside it has been read. */}
              <div className="row" style={{ gap: 'var(--s-4)', alignItems: 'flex-start' }}>
                <ProgressRing progress={course.enrollment.progress} />
                <h3 className="grow" style={{ margin: 0 }}>
                  <Link href={`/courses/${course.slug}`}>{course.title}</Link>
                </h3>
              </div>
              <div className="meter" aria-hidden="true">
                <span style={{ width: `${course.enrollment.progress * 100}%` }} />
              </div>
              <div className="course-meta">
                <span className={`badge badge-${course.enrollment.status.toLowerCase()}`}>
                  {course.enrollment.status}
                </span>
                {course.enrollment.certificateSerial ? (
                  <Link href={`/verify/${course.enrollment.certificateSerial}`}>Certificate</Link>
                ) : null}
              </div>
            </article>
          ))}
        </div>
      )}
    </main>
  );
}
