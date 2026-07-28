'use client';

import { useTransition } from 'react';
import { setRoleAction } from '../app/admin/actions';

const ROLES = ['STUDENT', 'INSTRUCTOR', 'ADMIN'] as const;

export function RoleControls({
  userId,
  role,
  isSelf,
}: {
  userId: string;
  role: (typeof ROLES)[number];
  isSelf: boolean;
}) {
  const [pending, start] = useTransition();

  // An admin cannot change their own role. Not paranoia about malice: a
  // single-admin install that demotes itself needs a database console to
  // recover, and the API refuses it anyway.
  if (isSelf) {
    return <span className="badge" data-testid={`role-${userId}`}>{role} (you)</span>;
  }

  return (
    <select
      value={role}
      disabled={pending}
      data-testid={`role-select-${userId}`}
      onChange={(event) =>
        start(() => void setRoleAction(userId, event.target.value as (typeof ROLES)[number]))
      }
    >
      {ROLES.map((option) => (
        <option key={option} value={option}>
          {option}
        </option>
      ))}
    </select>
  );
}
