'use client';

import { useFormState } from 'react-dom';
import { createCourseAction, type ActionState } from '../app/instructor/actions';
import { SubmitButton } from './submit-button';

export function CreateCourseForm() {
  const [state, action] = useFormState<ActionState, FormData>(createCourseAction, {});

  return (
    <details className="card" data-testid="create-course">
      <summary className="mono">New course</summary>
      <form action={action}>
        {state.error ? <p className="notice">{state.error}</p> : null}
        <label>
          Title
          <input name="title" required minLength={3} maxLength={160} data-testid="course-title" />
        </label>
        <label>
          Summary
          <input
            name="summary"
            required
            minLength={3}
            maxLength={300}
            data-testid="course-summary"
          />
        </label>
        <label>
          Description
          <textarea name="description" rows={3} maxLength={5000} />
        </label>
        <p style={{ marginTop: 16 }}>
          <SubmitButton
            className="btn btn-primary"
            pendingLabel="Creating…"
            testId="create-course-submit"
          >
            Create
          </SubmitButton>
        </p>
      </form>
    </details>
  );
}
