import type { CourseSummary } from '@lms/shared/client';
import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '../../../auth';
import { CreateCourseForm } from '../../../components/create-course-form';
import { apiFetch } from '../../../lib/api';

export default async function InstructorPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'INSTRUCTOR' && session.user.role !== 'ADMIN') redirect('/');

  const courses = await apiFetch<CourseSummary[]>('/instructor/courses');

  return (
    <main className="container">
      <h1>Instructor</h1>

      <div className="stat-row">
        <div className="stat">
          <span className="label">Courses</span>
          <span className="value">{courses.length}</span>
        </div>
        <div className="stat">
          <span className="label">Published</span>
          <span className="value">
            {courses.filter((course) => course.status === 'PUBLISHED').length}
          </span>
        </div>
        <div className="stat">
          <span className="label">Students</span>
          <span className="value">
            {courses.reduce((total, course) => total + course.enrolledCount, 0)}
          </span>
        </div>
      </div>

      <CreateCourseForm />

      <h2>Your courses</h2>
      {courses.length === 0 ? (
        <p className="empty">No courses yet</p>
      ) : (
        <table className="table" data-testid="instructor-courses">
          <thead>
            <tr>
              <th>Title</th>
              <th>Status</th>
              <th className="num">Lessons</th>
              <th className="num">Students</th>
            </tr>
          </thead>
          <tbody>
            {courses.map((course) => (
              <tr key={course.id}>
                <td>
                  <Link href={`/instructor/courses/${course.id}`}>{course.title}</Link>
                </td>
                <td>
                  <span className={`badge badge-${course.status.toLowerCase()}`}>
                    {course.status}
                  </span>
                </td>
                <td className="num">{course.lessonCount}</td>
                <td className="num">{course.enrolledCount}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
