import { NextResponse } from 'next/server';
import { auth } from '../../../../auth';
import { mintServiceToken } from '../../../../lib/service-token';
import { API_BASE_URL } from '../../../../lib/config';

/**
 * Proxy the certificate PDF.
 *
 * The download has to be a plain link a browser can follow, which means no
 * Authorization header. Rather than opening an unauthenticated download route
 * on the API, the web server fetches it with a freshly minted service token and
 * streams the bytes back — so the credential never leaves the server and the
 * PDF is still one click.
 */
export async function GET(
  _request: Request,
  { params }: { params: { serial: string } },
): Promise<Response> {
  const session = await auth();
  if (!session?.user) return NextResponse.json({ message: 'Not authenticated' }, { status: 401 });

  const token = mintServiceToken(session.user.id, session.user.email, session.user.role);
  const upstream = await fetch(
    `${API_BASE_URL}/certificates/${encodeURIComponent(params.serial)}/pdf`,
    { headers: { authorization: `Bearer ${token}` }, cache: 'no-store' },
  );
  if (!upstream.ok) {
    return NextResponse.json({ message: 'Certificate not found' }, { status: upstream.status });
  }

  return new NextResponse(upstream.body, {
    headers: {
      'content-type': 'application/pdf',
      'content-disposition': `attachment; filename="${params.serial}.pdf"`,
      'cache-control': 'no-store',
    },
  });
}
