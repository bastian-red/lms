/**
 * Quiz grading.
 *
 * Pure and server-only by construction. The types here carry `isCorrect` and
 * `acceptedAnswers`, which is exactly why the student-facing DTO is built by a
 * separate, explicit projection (`toStudentQuiz`) rather than by spreading a
 * database row and deleting fields. A `delete row.isCorrect` on a nested array
 * is one refactor away from leaking the whole answer key into the HTML.
 */

export type QuestionKind = 'SINGLE' | 'MULTI' | 'TRUE_FALSE' | 'SHORT_TEXT';

/** A choice as the server knows it, answer key included. */
export interface GradableChoice {
  id: string;
  label: string;
  isCorrect: boolean;
}

/** A question as the server knows it. */
export interface GradableQuestion {
  id: string;
  kind: QuestionKind;
  prompt: string;
  /** Relative weight. A 2-point question counts double toward the score. */
  points: number;
  choices: GradableChoice[];
  /** Accepted free-text answers, compared after normalisation. */
  acceptedAnswers: string[];
}

export interface GradableQuiz {
  id: string;
  title: string;
  /** Percentage needed to pass, 0-100. */
  passingScore: number;
  questions: GradableQuestion[];
}

/** One student answer. Choice questions use `choiceIds`; text uses `text`. */
export interface SubmittedAnswer {
  questionId: string;
  choiceIds?: string[];
  text?: string;
}

export interface QuestionOutcome {
  questionId: string;
  correct: boolean;
  points: number;
  earned: number;
}

export interface GradeResult {
  /** 0-100, rounded to two decimals. */
  scorePercent: number;
  passed: boolean;
  earnedPoints: number;
  totalPoints: number;
  outcomes: QuestionOutcome[];
}

/**
 * Normalise free text before comparison: trim, collapse internal whitespace,
 * casefold, and strip diacritics.
 *
 * NFD then stripping the combining range is what makes "café" and "cafe" the
 * same answer. Without it a student typing the unaccented form of a word the
 * instructor accented is marked wrong for a reason no one can see.
 */
export function normalizeText(value: string): string {
  return value
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLocaleLowerCase('en-US');
}

/**
 * Whether the submitted ids are exactly the expected ones.
 *
 * The duplicate check is on the *submitted* side, and that is the whole point.
 * A student who selects the same correct choice twice matches the expected
 * count and every expected id, so a naive length-plus-membership check passes
 * them on a question they only half answered.
 */
function sameIdSet(expected: string[], submitted: string[]): boolean {
  if (expected.length !== submitted.length) return false;
  const unique = new Set(submitted);
  if (unique.size !== submitted.length) return false;
  return expected.every((id) => unique.has(id));
}

/**
 * Grade one question.
 *
 * MULTI is all-or-nothing: selecting three of four correct options scores zero.
 * Partial credit on a multi-select is a policy decision that changes what a
 * passing score means, so it is deliberately not smuggled in as a default. If a
 * course wants it, it becomes an explicit per-quiz setting and a new test.
 */
export function gradeQuestion(question: GradableQuestion, answer: SubmittedAnswer | undefined): boolean {
  if (!answer) return false;

  switch (question.kind) {
    case 'SHORT_TEXT': {
      if (typeof answer.text !== 'string') return false;
      const submitted = normalizeText(answer.text);
      if (submitted === '') return false;
      return question.acceptedAnswers.some((accepted) => normalizeText(accepted) === submitted);
    }
    case 'SINGLE':
    case 'TRUE_FALSE': {
      const selected = answer.choiceIds ?? [];
      if (selected.length !== 1) return false;
      const choice = question.choices.find((c) => c.id === selected[0]);
      return choice?.isCorrect === true;
    }
    case 'MULTI': {
      const correct = question.choices.filter((c) => c.isCorrect).map((c) => c.id);
      // A question with no correct choice is a content bug. Grading it as
      // "correct when you select nothing" would hand out free marks, so it is
      // always wrong and shows up as a whole cohort failing one question.
      if (correct.length === 0) return false;
      return sameIdSet(correct, answer.choiceIds ?? []);
    }
    default:
      return false;
  }
}

/**
 * Grade a whole attempt.
 *
 * Unanswered questions score zero rather than being skipped: dividing by "the
 * questions they chose to answer" would let a student pass a twenty-question
 * quiz by answering the one they knew.
 */
export function gradeAttempt(quiz: GradableQuiz, answers: SubmittedAnswer[]): GradeResult {
  const byQuestion = new Map<string, SubmittedAnswer>();
  for (const answer of answers) {
    // Last submission wins, and a duplicate for a question that does not exist
    // in this quiz is ignored rather than counted.
    byQuestion.set(answer.questionId, answer);
  }

  const outcomes: QuestionOutcome[] = quiz.questions.map((question) => {
    const points = question.points > 0 ? question.points : 1;
    const correct = gradeQuestion(question, byQuestion.get(question.id));
    return { questionId: question.id, correct, points, earned: correct ? points : 0 };
  });

  const totalPoints = outcomes.reduce((sum, o) => sum + o.points, 0);
  const earnedPoints = outcomes.reduce((sum, o) => sum + o.earned, 0);
  // An empty quiz scores 0, not NaN. It cannot be passed, which is correct: a
  // quiz with no questions is not evidence of anything.
  const scorePercent = totalPoints > 0 ? round2((earnedPoints / totalPoints) * 100) : 0;

  return {
    scorePercent,
    passed: totalPoints > 0 && scorePercent >= quiz.passingScore,
    earnedPoints,
    totalPoints,
    outcomes,
  };
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/** A choice with the answer key removed. */
export interface StudentChoice {
  id: string;
  label: string;
}

export interface StudentQuestion {
  id: string;
  kind: QuestionKind;
  prompt: string;
  points: number;
  choices: StudentChoice[];
}

export interface StudentQuiz {
  id: string;
  title: string;
  passingScore: number;
  questions: StudentQuestion[];
}

/**
 * Build the student-facing quiz.
 *
 * Written as an explicit whitelist — every field is named — rather than as a
 * spread with deletions. The difference matters: a spread carries whatever the
 * database adds next, so the day someone adds an `explanation` or a
 * `correctChoiceId` column it ships to the browser silently. Here, a new field
 * has to be added on purpose.
 *
 * `acceptedAnswers` and `isCorrect` have no path out of this function. The unit
 * test deep-scans the result for both, so a future refactor that reintroduces a
 * spread fails the gate lane.
 */
export function toStudentQuiz(quiz: GradableQuiz): StudentQuiz {
  return {
    id: quiz.id,
    title: quiz.title,
    passingScore: quiz.passingScore,
    questions: quiz.questions.map((question) => ({
      id: question.id,
      kind: question.kind,
      prompt: question.prompt,
      points: question.points,
      // SHORT_TEXT questions have no choices to send; the array is empty rather
      // than absent so the client has one shape to render.
      choices:
        question.kind === 'SHORT_TEXT'
          ? []
          : question.choices.map((choice) => ({ id: choice.id, label: choice.label })),
    })),
  };
}

/**
 * Recursively collect every key name in a value. Used by the test that asserts
 * the answer key is absent, so the assertion holds however the DTO is nested.
 */
export function collectKeys(value: unknown, into: Set<string> = new Set()): Set<string> {
  if (Array.isArray(value)) {
    for (const entry of value) collectKeys(entry, into);
    return into;
  }
  if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) {
      into.add(key);
      collectKeys(entry, into);
    }
  }
  return into;
}
