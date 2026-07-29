import type { CourseSummary, EnrollmentSummary } from '@lms/shared/client';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '../../../../auth';
import { apiFetch } from '../../../../lib/api';

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
              <h3>
                <Link href={`/courses/${course.slug}`}>{course.title}</Link>
              </h3>
              <div className="progress-line">
                <span>Progress</span>
                <b>{Math.round(course.enrollment.progress * 100)}%</b>
              </div>
              <div className="meter">
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
