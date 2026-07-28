'use client';

import { MIN_PASSWORD_LENGTH } from '@lms/shared/client';
import { useState } from 'react';
import { useFormState } from 'react-dom';
import type { FormState } from '../app/auth-actions';
import { SubmitButton } from './submit-button';

interface Props {
  mode: 'login' | 'signup';
  action: (state: FormState, formData: FormData) => Promise<FormState>;
}

/**
 * A live strength meter, on signup only.
 *
 * Length-driven, matching the server policy in `@lms/shared`. Composition rules
 * (a symbol, a digit, a capital) push people toward `Password1!`, which is
 * measurably worse than a long phrase, so the meter rewards what the policy
 * actually requires rather than inventing a second opinion.
 */
function strengthSegments(password: string): { filled: number; label: string } {
  if (password.length === 0) return { filled: 0, label: '' };
  if (password.length < MIN_PASSWORD_LENGTH) return { filled: 1, label: 'Too short' };
  if (password.length < 16) return { filled: 2, label: 'OK' };
  if (password.length < 24) return { filled: 3, label: 'Good' };
  return { filled: 4, label: 'Strong' };
}

export function AuthForm({ mode, action }: Props) {
  // useFormState, not useActionState: the latter is React 19, and this app is
  // on React 18 + Next 14. It type-checks either way and fails at runtime.
  const [state, formAction] = useFormState<FormState, FormData>(action, {});
  const [password, setPassword] = useState('');
  const meter = strengthSegments(password);

  return (
    <form action={formAction}>
      {state.error ? (
        <p className="notice" data-testid="auth-error">
          {state.error}
        </p>
      ) : null}

      {mode === 'signup' ? (
        <label>
          Name
          <input name="name" required maxLength={120} autoComplete="name" data-testid="name" />
        </label>
      ) : null}

      <label>
        Email
        <input name="email" type="email" required autoComplete="email" data-testid="email" />
      </label>

      <label>
        Password
        <input
          name="password"
          type="password"
          required
          minLength={mode === 'signup' ? MIN_PASSWORD_LENGTH : 1}
          autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          data-testid="password"
        />
      </label>

      {mode === 'signup' ? (
        <>
          <div className="strength">
            <div className="strength-bars">
              {[0, 1, 2, 3].map((index) => (
                <span key={index} className={`strength-seg${index < meter.filled ? ' on' : ''}`} />
              ))}
            </div>
            <span className="strength-label" data-testid="strength-label">
              {meter.label}
            </span>
          </div>
          {/* Hidden from layout and from assistive tech, still in the DOM: a
              person never fills it, a naive bot always does. */}
          <div className="hp" aria-hidden="true">
            <label>
              Website
              <input name="website" tabIndex={-1} autoComplete="off" />
            </label>
          </div>
        </>
      ) : null}

      <p style={{ marginTop: 20 }}>
        <SubmitButton className="btn btn-primary" pendingLabel="Working…" testId="auth-submit">
          {mode === 'signup' ? 'Create account' : 'Sign in'}
        </SubmitButton>
      </p>
    </form>
  );
}
