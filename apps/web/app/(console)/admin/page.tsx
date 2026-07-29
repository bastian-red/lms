import { redirect } from 'next/navigation';
import { auth } from '../../../auth';
import { RoleControls } from '../../../components/role-controls';
import { apiFetch } from '../../../lib/api';

interface Stats {
  users: number;
  courses: number;
  publishedCourses: number;
  enrollments: number;
  certificates: number;
  videoAssets: Record<string, number>;
  transcodeJobs: Record<string, number>;
}

interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  role: 'STUDENT' | 'INSTRUCTOR' | 'ADMIN';
  createdAt: string;
  _count: { enrollments: number; courses: number };
}

export default async function AdminPage() {
  const session = await auth();
  if (!session?.user) redirect('/login');
  if (session.user.role !== 'ADMIN') redirect('/');

  const [stats, users] = await Promise.all([
    apiFetch<Stats>('/admin/stats'),
    apiFetch<AdminUser[]>('/admin/users'),
  ]);

  return (
    <main className="container-wide">
      <h1>Admin</h1>

      <div className="stat-row">
        <div className="stat">
          <span className="label">Users</span>
          <span className="value">{stats.users}</span>
        </div>
        <div className="stat">
          <span className="label">Courses</span>
          <span className="value">
            {stats.publishedCourses}/{stats.courses}
          </span>
        </div>
        <div className="stat">
          <span className="label">Enrollments</span>
          <span className="value">{stats.enrollments}</span>
        </div>
        <div className="stat">
          <span className="label">Certificates</span>
          <span className="value">{stats.certificates}</span>
        </div>
      </div>

      <h2>Pipeline</h2>
      <div className="stat-row" data-testid="pipeline-stats">
        {(['PENDING', 'PROCESSING', 'READY', 'FAILED'] as const).map((status) => (
          <div key={status} className="stat">
            <span className="label">Assets {status}</span>
            <span className="value">{stats.videoAssets[status] ?? 0}</span>
          </div>
        ))}
      </div>
      <div className="stat-row">
        {(['QUEUED', 'RUNNING', 'DONE', 'FAILED'] as const).map((status) => (
          <div key={status} className="stat">
            <span className="label">Jobs {status}</span>
            <span className="value">{stats.transcodeJobs[status] ?? 0}</span>
          </div>
        ))}
      </div>

      <h2>Users</h2>
      <table className="table" data-testid="admin-users">
        <thead>
          <tr>
            <th>Email</th>
            <th>Name</th>
            <th>Role</th>
            <th className="num">Enrolled</th>
            <th className="num">Teaching</th>
          </tr>
        </thead>
        <tbody>
          {users.map((user) => (
            <tr key={user.id} data-testid={`user-${user.email}`}>
              <td className="mono">{user.email}</td>
              <td>{user.name ?? '—'}</td>
              <td>
                <RoleControls
                  userId={user.id}
                  role={user.role}
                  isSelf={user.id === session.user.id}
                  userLabel={user.email}
                />
              </td>
              <td className="num">{user._count.enrollments}</td>
              <td className="num">{user._count.courses}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </main>
  );
}
