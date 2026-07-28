'use client';

import type { ReactNode } from 'react';
import { useFormStatus } from 'react-dom';

/**
 * A submit button that knows whether its own form is in flight.
 *
 * `useFormStatus` only reports the status of the form the component is rendered
 * *inside*, which is why this is a separate component rather than a hook call
 * in the form itself. Called there it would always report idle, and every button
 * in the app would look responsive while doing nothing.
 */
export function SubmitButton({
  children,
  pendingLabel,
  className = 'btn',
  testId,
}: {
  children: ReactNode;
  pendingLabel: string;
  className?: string;
  testId?: string;
}) {
  const { pending } = useFormStatus();
  return (
    <button type="submit" className={className} disabled={pending} data-testid={testId}>
      {pending ? pendingLabel : children}
    </button>
  );
}
