'use server';

import { revalidateTag } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, apiFetch } from '../lib/api';

/** Enroll and go straight to the first lesson. */
export async function enrollAction(courseId: string, slug: string): Promise<void> {
  await apiFetch(`/courses/${courseId}/enroll`, { method: 'POST' });
  // The catalogue shows enrolment counts, so publishing a new enrolment
  // invalidates exactly that tag rather than the whole cache.
  revalidateTag('courses');
  redirect(`/courses/${slug}`);
}

export interface CertificateState {
  error?: string;
  outstanding?: string[];
  serial?: string;
}

/**
 * Request the certificate.
 *
 * A 409 is not a failure to hide: it carries the list of lessons still
 * outstanding, which is the single most useful thing to show a student who
 * thought they were done.
 */
export async function requestCertificateAction(
  _prev: CertificateState,
  formData: FormData,
): Promise<CertificateState> {
  const courseId = String(formData.get('courseId') ?? '');
  if (!courseId) return { error: 'Missing course.' };

  try {
    const certificate = await apiFetch<{ serial: string }>(`/courses/${courseId}/certificate`, {
      method: 'POST',
    });
    return { serial: certificate.serial };
  } catch (error) {
    if (error instanceof ApiError && error.status === 409) {
      const body = error.body as { outstanding?: string[] } | undefined;
      return { error: error.message, outstanding: body?.outstanding ?? [] };
    }
    return { error: error instanceof Error ? error.message : 'Could not issue the certificate.' };
  }
}
