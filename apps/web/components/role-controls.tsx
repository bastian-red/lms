'use client';

import { useTransition } from 'react';
import { setRoleAction } from '../app/(console)/admin/actions';

const ROLES = ['STUDENT', 'INSTRUCTOR', 'ADMIN'] as const;

export function RoleControls({
  userId,
  role,
  isSelf,
  userLabel,
}: {
  userId: string;
  role: (typeof ROLES)[number];
  isSelf: boolean;
  /** Whose role this is. Without it the select has no accessible name. */
  userLabel: string;
}) {
  const [pending, start] = useTransition();

  // An admin cannot change their own role. Not paranoia about malice: a
  // single-admin install that demotes itself needs a database console to
  // recover, and the API refuses it anyway.
  if (isSelf) {
    return <span className="badge" data-testid={`role-${userId}`}>{role} (you)</span>;
  }

  return (
    // A bare <select> in a table cell has no accessible name: a screen-reader
    // user hears "STUDENT, combo box" with no indication of whose role it sets,
    // on a page listing every user. The label names the row.
    <select
      value={role}
      disabled={pending}
      aria-label={`Role for ${userLabel}`}
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
