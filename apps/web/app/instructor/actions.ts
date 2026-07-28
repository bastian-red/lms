'use server';

import { revalidatePath, revalidateTag } from 'next/cache';
import { redirect } from 'next/navigation';
import { ApiError, apiFetch } from '../../lib/api';

export interface ActionState {
  error?: string;
}

export async function createCourseAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  let created: { id: string };
  try {
    created = await apiFetch<{ id: string }>('/instructor/courses', {
      method: 'POST',
      body: JSON.stringify({
        title: String(formData.get('title') ?? ''),
        summary: String(formData.get('summary') ?? ''),
        description: String(formData.get('description') ?? ''),
      }),
    });
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : 'Could not create the course.' };
  }
  redirect(`/instructor/courses/${created.id}`);
}

export async function addModuleAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const courseId = String(formData.get('courseId') ?? '');
  try {
    await apiFetch(`/instructor/courses/${courseId}/modules`, {
      method: 'POST',
      body: JSON.stringify({ title: String(formData.get('title') ?? '') }),
    });
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : 'Could not add the module.' };
  }
  revalidatePath(`/instructor/courses/${courseId}`);
  return {};
}

export async function addLessonAction(
  _prev: ActionState,
  formData: FormData,
): Promise<ActionState> {
  const courseId = String(formData.get('courseId') ?? '');
  try {
    await apiFetch(`/instructor/courses/${courseId}/lessons`, {
      method: 'POST',
      body: JSON.stringify({
        moduleId: String(formData.get('moduleId') ?? ''),
        title: String(formData.get('title') ?? ''),
        kind: String(formData.get('kind') ?? 'VIDEO'),
        isPreview: formData.get('isPreview') === 'on',
      }),
    });
  } catch (error) {
    return { error: error instanceof ApiError ? error.message : 'Could not add the lesson.' };
  }
  revalidatePath(`/instructor/courses/${courseId}`);
  return {};
}

export async function setCourseStatusAction(
  courseId: string,
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED',
): Promise<void> {
  await apiFetch(`/instructor/courses/${courseId}`, {
    method: 'PATCH',
    body: JSON.stringify({ status }),
  });
  // The public catalogue is cached with this tag, so publishing shows up
  // immediately rather than after the revalidation window.
  revalidateTag('courses');
  revalidatePath(`/instructor/courses/${courseId}`);
}

export async function revokeAction(enrollmentId: string, courseId: string): Promise<void> {
  await apiFetch(`/instructor/enrollments/${enrollmentId}/revoke`, { method: 'POST' });
  revalidatePath(`/instructor/courses/${courseId}`);
}

export async function reinstateAction(enrollmentId: string, courseId: string): Promise<void> {
  await apiFetch(`/instructor/enrollments/${enrollmentId}/reinstate`, { method: 'POST' });
  revalidatePath(`/instructor/courses/${courseId}`);
}
