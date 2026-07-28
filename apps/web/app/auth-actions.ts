'use server';

import { loginSchema, signupSchema } from '@lms/shared/client';
import { AuthError } from 'next-auth';
import { redirect } from 'next/navigation';
import { signIn } from '../auth';
import { API_BASE_URL } from '../lib/config';

export interface FormState {
  error?: string;
}

export async function loginAction(_prev: FormState, formData: FormData): Promise<FormState> {
  const parsed = loginSchema.safeParse({
    email: formData.get('email'),
    password: formData.get('password'),
  });
  if (!parsed.success) return { error: 'Enter your email and password.' };

  try {
    await signIn('credentials', { ...parsed.data, redirect: false });
  } catch (error) {
    // One message for both "no such account" and "wrong password". Telling them
    // apart is an account-enumeration oracle.
    if (error instanceof AuthError) return { error: 'Invalid email or password.' };
    throw error;
  }
  redirect('/my/courses');
}

export async function signupAction(_prev: FormState, formData: FormData): Promise<FormState> {
  // The honeypot. A field hidden from layout and from assistive technology, so
  // a person never fills it and a naive bot always does.
  if (typeof formData.get('website') === 'string' && formData.get('website') !== '') {
    return { error: 'Something went wrong. Try again.' };
  }

  const parsed = signupSchema.safeParse({
    email: formData.get('email'),
    name: formData.get('name'),
    password: formData.get('password'),
  });
  if (!parsed.success) {
    return { error: parsed.error.issues[0]?.message ?? 'Check the form and try again.' };
  }

  const response = await fetch(`${API_BASE_URL}/auth/signup`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(parsed.data),
  });
  if (!response.ok) {
    const body = (await response.json().catch(() => ({}))) as { message?: string };
    return { error: body.message ?? 'Could not create the account.' };
  }

  await signIn('credentials', {
    email: parsed.data.email,
    password: parsed.data.password,
    redirect: false,
  });
  redirect('/my/courses');
}
