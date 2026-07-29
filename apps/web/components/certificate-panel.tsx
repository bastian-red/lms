'use client';

import Link from 'next/link';
import { useFormState } from 'react-dom';
import { requestCertificateAction, type CertificateState } from '../app/actions';
import { SubmitButton } from './submit-button';

/**
 * Certificate issuing, with the honest failure case.
 *
 * A 409 carries the lessons still outstanding, and showing them is the whole
 * point: "you are not eligible" with no reason is a support ticket, while a
 * list of two lesson titles is a student going back to finish them.
 */
export function CertificatePanel({
  courseId,
  existingSerial,
}: {
  courseId: string;
  existingSerial: string | null;
}) {
  const [state, action] = useFormState<CertificateState, FormData>(
    requestCertificateAction,
    existingSerial ? { serial: existingSerial } : {},
  );

  if (state.serial) {
    return (
      <div className="certificate mt-6" data-testid="certificate">
        <span className="mono muted">Certificate of completion</span>
        <div className="serial" data-testid="certificate-serial">
          {state.serial}
        </div>
        <p className="stack">
          <a href={`/api/certificate/${state.serial}`} className="btn">
            Download PDF
          </a>{' '}
          <Link href={`/verify/${state.serial}`} className="btn">
            Verify
          </Link>
        </p>
      </div>
    );
  }

  return (
    <form action={action} className="mt-6">
      <input type="hidden" name="courseId" value={courseId} />
      <SubmitButton pendingLabel="Checking…" testId="request-certificate">
        Get certificate
      </SubmitButton>
      {state.error ? (
        <div className="notice mt-4" data-testid="certificate-error">
          {state.error}
          {state.outstanding && state.outstanding.length > 0 ? (
            <ul data-testid="outstanding">
              {state.outstanding.map((title) => (
                <li key={title}>{title}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </form>
  );
}
