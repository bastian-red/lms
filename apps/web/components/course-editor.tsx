'use client';

import { useState } from 'react';
import { useFormState } from 'react-dom';
import { useRouter } from 'next/navigation';
import {
  addLessonAction,
  addModuleAction,
  setCourseStatusAction,
  type ActionState,
} from '../app/instructor/actions';
import { SubmitButton } from './submit-button';
import { VideoUpload } from './video-upload';

interface Lesson {
  id: string;
  title: string;
  kind: 'VIDEO' | 'QUIZ';
  isPreview: boolean;
  published: boolean;
  quiz: { id: string; title: string; _count: { questions: number } } | null;
  videoAsset: {
    status: 'PENDING' | 'PROCESSING' | 'READY' | 'FAILED';
    durationSeconds: number;
    width: number;
    height: number;
    lastError: string | null;
    jobs: { status: string; attempts: number; lastError: string | null }[];
  } | null;
}

interface Course {
  id: string;
  status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED';
  modules: { id: string; title: string; lessons: Lesson[] }[];
}

export function CourseEditor({
  course,
  apiBaseUrl,
  token,
}: {
  course: Course;
  apiBaseUrl: string;
  token: string;
}) {
  const router = useRouter();
  const [moduleState, addModule] = useFormState<ActionState, FormData>(addModuleAction, {});
  const [lessonState, addLesson] = useFormState<ActionState, FormData>(addLessonAction, {});
  const [busy, setBusy] = useState(false);

  const setStatus = (status: 'DRAFT' | 'PUBLISHED' | 'ARCHIVED'): void => {
    setBusy(true);
    void setCourseStatusAction(course.id, status).finally(() => {
      setBusy(false);
      router.refresh();
    });
  };

  return (
    <div>
      <p className="stack">
        {course.status !== 'PUBLISHED' ? (
          <button
            type="button"
            className="btn btn-primary"
            disabled={busy}
            onClick={() => setStatus('PUBLISHED')}
            data-testid="publish-course"
          >
            Publish
          </button>
        ) : (
          <button
            type="button"
            className="btn"
            disabled={busy}
            onClick={() => setStatus('DRAFT')}
            data-testid="unpublish-course"
          >
            Unpublish
          </button>
        )}
      </p>

      <div className="syllabus" data-testid="course-modules">
        {course.modules.map((module) => (
          <section key={module.id} className="syllabus-module">
            <header>
              <span>{module.title}</span>
              <span>{module.lessons.length} lessons</span>
            </header>

            {module.lessons.map((lesson) => (
              <div key={lesson.id} style={{ borderTop: '1px solid var(--border)', padding: '12px 16px' }}>
                <div className="lesson-row" style={{ border: 'none', padding: 0 }}>
                  <span style={{ flex: 1 }}>{lesson.title}</span>
                  <span className="badge">{lesson.kind}</span>
                  {lesson.isPreview ? <span className="badge">Preview</span> : null}
                  {lesson.videoAsset ? (
                    <span
                      className={`badge badge-${lesson.videoAsset.status.toLowerCase()}`}
                      data-testid={`asset-status-${lesson.id}`}
                    >
                      {lesson.videoAsset.status}
                    </span>
                  ) : null}
                </div>

                {lesson.kind === 'VIDEO' ? (
                  <>
                    <VideoUpload lessonId={lesson.id} apiBaseUrl={apiBaseUrl} token={token} />
                    {lesson.videoAsset?.status === 'READY' ? (
                      <p className="job-line">
                        {lesson.videoAsset.width}×{lesson.videoAsset.height} ·{' '}
                        {Math.round(lesson.videoAsset.durationSeconds)}s
                      </p>
                    ) : null}
                    {lesson.videoAsset?.lastError ? (
                      <pre className="job-error" data-testid={`asset-error-${lesson.id}`}>
                        {lesson.videoAsset.lastError}
                      </pre>
                    ) : null}
                  </>
                ) : (
                  <p className="job-line">
                    {lesson.quiz ? `${lesson.quiz._count.questions} questions` : 'No quiz yet'}
                  </p>
                )}
              </div>
            ))}

            <form action={addLesson} style={{ padding: '12px 16px', borderTop: '1px solid var(--border)' }}>
              <input type="hidden" name="courseId" value={course.id} />
              <input type="hidden" name="moduleId" value={module.id} />
              <label>
                New lesson
                <input name="title" required maxLength={160} data-testid={`lesson-title-${module.id}`} />
              </label>
              <label>
                Kind
                <select name="kind" data-testid={`lesson-kind-${module.id}`}>
                  <option value="VIDEO">Video</option>
                  <option value="QUIZ">Quiz</option>
                </select>
              </label>
              <p style={{ marginTop: 12 }}>
                <SubmitButton pendingLabel="Adding…" testId={`add-lesson-${module.id}`}>
                  Add lesson
                </SubmitButton>
              </p>
              {lessonState.error ? <p className="notice">{lessonState.error}</p> : null}
            </form>
          </section>
        ))}
      </div>

      <form action={addModule} className="card" style={{ marginTop: 16 }}>
        <input type="hidden" name="courseId" value={course.id} />
        <label>
          New module
          <input name="title" required maxLength={160} data-testid="module-title" />
        </label>
        <p style={{ marginTop: 12 }}>
          <SubmitButton pendingLabel="Adding…" testId="add-module">
            Add module
          </SubmitButton>
        </p>
        {moduleState.error ? <p className="notice">{moduleState.error}</p> : null}
      </form>
    </div>
  );
}
