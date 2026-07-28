'use client';

import type { LessonPlayback } from '@lms/shared/client';
import Link from 'next/link';
import { useRouter } from 'next/navigation';
import { useState } from 'react';
import { LessonPlayer } from './lesson-player';
import { QuizForm } from './quiz-form';

/**
 * The lesson body: a player or a quiz, plus whatever follows from finishing it.
 *
 * A client component because completion changes the page without a navigation —
 * the "next lesson" affordance has to appear the moment the last second is
 * credited, not on a reload the student has no reason to perform.
 */
export function LessonView({
  lesson,
  token,
  apiBaseUrl,
  nextHref,
}: {
  lesson: LessonPlayback;
  token: string;
  apiBaseUrl: string;
  nextHref: string | null;
}) {
  const router = useRouter();
  const [completed, setCompleted] = useState(lesson.completed);
  const [clamped, setClamped] = useState(false);

  return (
    <div>
      {lesson.kind === 'VIDEO' ? (
        <LessonPlayer
          lesson={lesson}
          token={token}
          apiBaseUrl={apiBaseUrl}
          onProgress={(progress) => {
            setClamped(progress.clamped);
            if (progress.completed && !completed) {
              setCompleted(true);
              // Refresh the server components so the syllabus marker and the
              // course progress bar update without a full navigation.
              router.refresh();
            }
          }}
        />
      ) : lesson.quiz ? (
        <QuizForm
          lessonId={lesson.lessonId}
          quiz={lesson.quiz}
          token={token}
          apiBaseUrl={apiBaseUrl}
          bestScorePercent={lesson.bestScorePercent}
          alreadyPassed={lesson.quizPassed}
          onPassed={() => {
            setCompleted(true);
            router.refresh();
          }}
        />
      ) : (
        <p className="empty">This lesson has no content yet</p>
      )}

      {clamped ? (
        <p className="notice" data-testid="progress-clamped">
          Some reported progress was refused: it exceeded the time that has actually passed.
        </p>
      ) : null}

      {completed ? (
        <p className="notice notice-ok" data-testid="lesson-complete">
          Lesson complete.{' '}
          {nextHref ? (
            <Link href={nextHref} data-testid="next-lesson">
              Next lesson
            </Link>
          ) : (
            'That was the last one.'
          )}
        </p>
      ) : null}
    </div>
  );
}
