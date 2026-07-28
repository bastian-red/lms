'use client';

import { useTransition } from 'react';
import { enrollAction } from '../app/actions';

export function EnrollButton({ courseId, slug }: { courseId: string; slug: string }) {
  const [pending, start] = useTransition();
  return (
    <button
      type="button"
      className="btn btn-primary"
      disabled={pending}
      data-testid="enroll"
      onClick={() => start(() => void enrollAction(courseId, slug))}
    >
      {pending ? 'Enrolling…' : 'Enroll'}
    </button>
  );
}
