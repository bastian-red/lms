'use client';

import { useTransition } from 'react';
import { reinstateAction, revokeAction } from '../app/(console)/instructor/actions';

/**
 * Revoke or reinstate one student.
 *
 * The consequence of revoking is immediate and worth knowing: because the key
 * endpoint re-reads the enrollment on every fetch, the student's playback stops
 * within one segment, even though the playback ticket in their browser stays
 * cryptographically valid for hours.
 */
export function RosterControls({
  enrollmentId,
  courseId,
  status,
}: {
  enrollmentId: string;
  courseId: string;
  status: string;
}) {
  const [pending, start] = useTransition();

  if (status === 'REVOKED') {
    return (
      <button
        type="button"
        className="btn"
        disabled={pending}
        data-testid={`reinstate-${enrollmentId}`}
        onClick={() => start(() => void reinstateAction(enrollmentId, courseId))}
      >
        {pending ? 'Working…' : 'Reinstate'}
      </button>
    );
  }

  return (
    <button
      type="button"
      className="btn"
      disabled={pending}
      data-testid={`revoke-${enrollmentId}`}
      onClick={() => start(() => void revokeAction(enrollmentId, courseId))}
    >
      {pending ? 'Working…' : 'Revoke'}
    </button>
  );
}
