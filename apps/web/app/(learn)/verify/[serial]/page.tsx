import type { CertificateVerification } from '@lms/shared/client';
import { publicApiFetch } from '../../../../lib/api';

/**
 * Public certificate check.
 *
 * No auth, deliberately: the point of a serial printed on a certificate is that
 * a stranger — an employer, an admissions office — can check it. It shows the
 * minimum that makes the check meaningful and nothing else.
 */
export default async function VerifyPage({ params }: { params: { serial: string } }) {
  const result = await publicApiFetch<CertificateVerification>(
    `/verify/${encodeURIComponent(params.serial)}`,
  );

  return (
    <main className="container auth-wrap">
      <h1>Certificate check</h1>
      <div
        className={`verify-result${result.valid ? '' : ' invalid'}`}
        data-testid="verify-result"
        data-valid={String(result.valid)}
      >
        {result.valid ? (
          <>
            <p className="mono muted">Valid</p>
            <p className="verify-name">{result.studentName}</p>
            <p>{result.courseTitle}</p>
            <p className="mono muted">
              Issued {result.issuedAt ? result.issuedAt.slice(0, 10) : ''} · {result.serial}
            </p>
          </>
        ) : (
          <>
            <p className="mono muted">No match</p>
            <p>No certificate has been issued with this serial.</p>
          </>
        )}
      </div>
    </main>
  );
}
