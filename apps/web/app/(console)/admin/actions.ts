'use server';

import { revalidatePath } from 'next/cache';
import { apiFetch } from '../../../lib/api';

export async function setRoleAction(
  userId: string,
  role: 'STUDENT' | 'INSTRUCTOR' | 'ADMIN',
): Promise<void> {
  await apiFetch(`/admin/users/${userId}/role`, {
    method: 'POST',
    body: JSON.stringify({ role }),
  });
  revalidatePath('/admin');
}
