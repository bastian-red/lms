'use client';

import type { QuizAttemptResult, StudentQuiz } from '@lms/shared/client';
import { useState } from 'react';

/**
 * The quiz.
 *
 * Everything about grading happens on the server. This component holds the
 * selections and renders the verdict it is given; it has no idea which answer
 * is correct, because the DTO it receives does not contain that information.
 * That is not an accident of this file — `toStudentQuiz` in `@lms/shared` is an
 * explicit whitelist, and a unit test deep-scans its output for `isCorrect`.
 *
 * The result marks each question right or wrong and stops there. Showing the
 * correct answer on a quiz with unlimited attempts turns it into a reading
 * exercise.
 */
export function QuizForm({
  lessonId,
  quiz,
  token,
  apiBaseUrl,
  bestScorePercent,
  alreadyPassed,
  onPassed,
}: {
  lessonId: string;
  quiz: StudentQuiz;
  token: string;
  apiBaseUrl: string;
  bestScorePercent: number | null;
  alreadyPassed: boolean;
  onPassed: () => void;
}) {
  const [choices, setChoices] = useState<Record<string, string[]>>({});
  const [texts, setTexts] = useState<Record<string, string>>({});
  const [result, setResult] = useState<QuizAttemptResult | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const verdict = new Map(result?.outcomes.map((outcome) => [outcome.questionId, outcome.correct]));

  const toggle = (questionId: string, choiceId: string, multi: boolean): void => {
    setChoices((current) => {
      const selected = current[questionId] ?? [];
      if (!multi) return { ...current, [questionId]: [choiceId] };
      return {
        ...current,
        [questionId]: selected.includes(choiceId)
          ? selected.filter((id) => id !== choiceId)
          : [...selected, choiceId],
      };
    });
  };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    setPending(true);
    setError(null);
    try {
      const answers = quiz.questions.map((question) =>
        question.kind === 'SHORT_TEXT'
          ? { questionId: question.id, text: texts[question.id] ?? '' }
          : { questionId: question.id, choiceIds: choices[question.id] ?? [] },
      );
      const response = await fetch(`${apiBaseUrl}/lessons/${lessonId}/quiz`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ answers }),
      });
      if (!response.ok) {
        setError('Could not submit the quiz. Try again.');
        return;
      }
      const graded = (await response.json()) as QuizAttemptResult;
      setResult(graded);
      if (graded.passed) onPassed();
    } finally {
      setPending(false);
    }
  };

  return (
    <form className="quiz" onSubmit={submit} data-testid="quiz">
      <h2 className="flush-top">{quiz.title}</h2>
      <p className="mono muted">
        Pass mark {quiz.passingScore}%
        {bestScorePercent !== null ? ` · your best ${bestScorePercent}%` : ''}
        {alreadyPassed ? ' · passed' : ''}
      </p>

      {quiz.questions.map((question) => {
        const state = verdict.get(question.id);
        const className =
          result === null ? 'question' : `question ${state ? 'correct' : 'incorrect'}`;
        return (
          <div key={question.id} className={className} data-testid="question">
            <p>
              {question.prompt}
              <span className="points">
                {question.points} {question.points === 1 ? 'point' : 'points'}
                {question.kind === 'MULTI' ? ' · select all that apply' : ''}
              </span>
              {/* The verdict in words and a glyph, not only as a coloured rule.
                  Red and green are the most common colour-vision collision
                  there is, and a border alone tells those readers nothing. */}
              {result !== null ? (
                <span className="verdict" data-testid={`verdict-${question.id}`}>
                  {state ? '✓ Correct' : '✗ Incorrect'}
                </span>
              ) : null}
            </p>

            {question.kind === 'SHORT_TEXT' ? (
              <input
                value={texts[question.id] ?? ''}
                onChange={(event) =>
                  setTexts((current) => ({ ...current, [question.id]: event.target.value }))
                }
                data-testid={`text-${question.id}`}
              />
            ) : (
              question.choices.map((choice) => (
                <label key={choice.id} className="choice">
                  <input
                    type={question.kind === 'MULTI' ? 'checkbox' : 'radio'}
                    name={question.id}
                    checked={(choices[question.id] ?? []).includes(choice.id)}
                    onChange={() => toggle(question.id, choice.id, question.kind === 'MULTI')}
                    data-testid={`choice-${choice.id}`}
                  />
                  <span>{choice.label}</span>
                </label>
              ))
            )}
          </div>
        );
      })}

      {error ? <p className="notice">{error}</p> : null}

      {result ? (
        <div className="mt-6" data-testid="quiz-result" data-passed={String(result.passed)}>
          <span className={`score ${result.passed ? 'pass' : 'fail'}`}>{result.scorePercent}%</span>
          <p className="mono muted">{result.passed ? 'Passed' : 'Not passed — try again'}</p>
        </div>
      ) : null}

      <p className="mt-6">
        <button type="submit" className="btn btn-primary" disabled={pending} data-testid="submit-quiz">
          {pending ? 'Grading…' : result ? 'Try again' : 'Submit'}
        </button>
      </p>
    </form>
  );
}
