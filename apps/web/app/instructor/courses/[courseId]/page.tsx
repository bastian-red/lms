import Link from 'next/link';
import { redirect } from 'next/navigation';
import { auth } from '../../../../auth';
import { CourseEditor } from '../../../../components/course-editor';
import { RetentionCharts } from '../../../../components/retention-charts';
import { RosterControls } from '../../../../components/roster-controls';
import { apiFetch } from '../../../../lib/api';
import { PUBLIC_API_BASE_URL } from '../../../../lib/config';
import { browserToken } from '../../../../lib/api';

interface EditableCourse {
  id: string;
  slug: string;
  title: string;
  summary: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  modules: {
    id: string;
    title: string;
    position: number;
    lessons: {
      id: string;
      title: string;
      kind: 'VIDEO' | 'QUIZ';
      position: number;
      isPreview: boolean;
      published: boolean;
      quiz: { id: string; title: string; _count: { questions: number } } | null;
      videoAsset: {
        id: string;
        status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
        durationSeconds: number;
        width: number;
        height: number;
        renditions: unknown;
        lastError: string | null;
        jobs: { status: string; attempts: number; lastError: string | null }[];
      } | null;
    }[];
  }[];
  _count: { enrollments: number };
}

interface Analytics {
  enrolled: number;
  lessons: {
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
  }[];
}

interface RosterRow {
  id: string;
  status: string;
  enrolledAt: string;
  student: { id: string; name: string | null; email: string };
  completedLessons: number;
  lessonCount: number;
  certificateSerial: string | null;
}

export default async function InstructorCoursePage({
  params,
}: {
  params: { courseId: string };
}) {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'INSTRUCTOR' && session.user.role !== 'ADMIN') redirect('/');

  const [course, analytics, roster, token] = await Promise.all([
    apiFetch<EditableCourse>(`/instructor/courses/${params.courseId}`),
    apiFetch<Analytics>(`/instructor/courses/${params.courseId}/analytics`),
    apiFetch<RosterRow[]>(`/instructor/courses/${params.courseId}/roster`),
    browserToken(),
  ]);

  return (
    <main className="container-wide">
      <p className="mono muted">
        <Link href="/instructor">Instructor</Link>
      </p>
      <h1>{course.title}</h1>
      <p className="mono muted">
        <span className={`badge badge-${course.status.toLowerCase()}`}>{course.status}</span>{' '}
        <Link href={`/courses/${course.slug}`}>View public page</Link>
      </p>

      <CourseEditor course={course} apiBaseUrl={PUBLIC_API_BASE_URL} token={token ?? ''} />

      <h2 style={{ marginTop: 40 }}>Retention</h2>
      <div className="stat-row">
        <div className="stat">
          <span className="label">Enrolled</span>
          <span className="value">{analytics.enrolled}</span>
        </div>
        <div className="stat">
          <span className="label">Video lessons</span>
          <span className="value">{analytics.lessons.length}</span>
        </div>
        <div className="stat">
          <span className="label">Certificates</span>
          <span className="value">
            {roster.filter((row) => row.certificateSerial !== null).length}
          </span>
        </div>
      </div>
      <RetentionCharts lessons={analytics.lessons} />

      <h2 style={{ marginTop: 40 }}>Roster</h2>
      {roster.length === 0 ? (
        <p className="empty">Nobody is enrolled yet</p>
      ) : (
        <table className="table" data-testid="roster">
          <thead>
            <tr>
              <th>Student</th>
              <th>Status</th>
              <th className="num">Progress</th>
              <th>Certificate</th>
              <th>Access</th>
            </tr>
          </thead>
          <tbody>
            {roster.map((row) => (
              <tr
                key={row.id}
                data-testid={`roster-${row.student.email}`}
                data-enrollment-id={row.id}
              >
                <td>
                  {row.student.name ?? row.student.email}
                  <br />
                  <span className="mono muted">{row.student.email}</span>
                </td>
                <td>
                  <span className={`badge badge-${row.status.toLowerCase()}`}>{row.status}</span>
                </td>
                <td className="num">
                  {row.completedLessons}/{row.lessonCount}
                </td>
                <td className="mono">{row.certificateSerial ?? '—'}</td>
                <td>
                  <RosterControls
                    enrollmentId={row.id}
                    courseId={course.id}
                    status={row.status}
                  />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </main>
  );
}
