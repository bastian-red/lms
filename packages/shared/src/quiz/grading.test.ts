import { describe, expect, it } from 'vitest';
import {
  collectKeys,
  gradeAttempt,
  gradeQuestion,
  normalizeText,
  toStudentQuiz,
  type GradableQuestion,
  type GradableQuiz,
} from './grading';

const single: GradableQuestion = {
  id: 'q-single',
  kind: 'SINGLE',
  prompt: 'Which HTTP status means Conflict?',
  points: 1,
  acceptedAnswers: [],
  choices: [
    { id: 'c1', label: '404', isCorrect: false },
    { id: 'c2', label: '409', isCorrect: true },
    { id: 'c3', label: '500', isCorrect: false },
  ],
};

const multi: GradableQuestion = {
  id: 'q-multi',
  kind: 'MULTI',
  prompt: 'Which are HLS artefacts?',
  points: 2,
  acceptedAnswers: [],
  choices: [
    { id: 'm1', label: 'master playlist', isCorrect: true },
    { id: 'm2', label: 'media playlist', isCorrect: true },
    { id: 'm3', label: 'sitemap.xml', isCorrect: false },
  ],
};

const trueFalse: GradableQuestion = {
  id: 'q-tf',
  kind: 'TRUE_FALSE',
  prompt: 'AES-128 HLS encrypts each segment.',
  points: 1,
  acceptedAnswers: [],
  choices: [
    { id: 't', label: 'True', isCorrect: true },
    { id: 'f', label: 'False', isCorrect: false },
  ],
};

const shortText: GradableQuestion = {
  id: 'q-text',
  kind: 'SHORT_TEXT',
  prompt: 'Name the MPEG-TS sync byte, in hex.',
  points: 1,
  acceptedAnswers: ['0x47', '47'],
  choices: [],
};

const quiz: GradableQuiz = {
  id: 'quiz-1',
  title: 'Streaming basics',
  passingScore: 70,
  questions: [single, multi, trueFalse, shortText],
};

describe('normalizeText', () => {
  it('is case and whitespace insensitive', () => {
    expect(normalizeText('  Hello   World ')).toBe('hello world');
  });

  it('strips diacritics so an unaccented answer still matches', () => {
    expect(normalizeText('café')).toBe(normalizeText('cafe'));
  });

  it('normalises decomposed and precomposed forms to the same string', () => {
    expect(normalizeText('é')).toBe(normalizeText('é'));
  });
});

describe('gradeQuestion', () => {
  it('marks an unanswered question wrong', () => {
    expect(gradeQuestion(single, undefined)).toBe(false);
  });

  it('grades SINGLE on the one correct choice', () => {
    expect(gradeQuestion(single, { questionId: single.id, choiceIds: ['c2'] })).toBe(true);
    expect(gradeQuestion(single, { questionId: single.id, choiceIds: ['c1'] })).toBe(false);
  });

  it('refuses a SINGLE answer that selects two choices', () => {
    // Otherwise "select everything" is a guaranteed pass.
    expect(gradeQuestion(single, { questionId: single.id, choiceIds: ['c1', 'c2'] })).toBe(false);
  });

  it('grades MULTI all-or-nothing', () => {
    expect(gradeQuestion(multi, { questionId: multi.id, choiceIds: ['m1', 'm2'] })).toBe(true);
    // Missing one correct option.
    expect(gradeQuestion(multi, { questionId: multi.id, choiceIds: ['m1'] })).toBe(false);
    // Correct ones plus a wrong one.
    expect(gradeQuestion(multi, { questionId: multi.id, choiceIds: ['m1', 'm2', 'm3'] })).toBe(false);
  });

  it('ignores the order of MULTI selections', () => {
    expect(gradeQuestion(multi, { questionId: multi.id, choiceIds: ['m2', 'm1'] })).toBe(true);
  });

  it('refuses MULTI padded with duplicates to reach the right count', () => {
    expect(gradeQuestion(multi, { questionId: multi.id, choiceIds: ['m1', 'm1'] })).toBe(false);
  });

  it('marks a MULTI with no correct choice wrong rather than free', () => {
    const broken: GradableQuestion = {
      ...multi,
      choices: multi.choices.map((c) => ({ ...c, isCorrect: false })),
    };
    expect(gradeQuestion(broken, { questionId: broken.id, choiceIds: [] })).toBe(false);
  });

  it('grades TRUE_FALSE', () => {
    expect(gradeQuestion(trueFalse, { questionId: trueFalse.id, choiceIds: ['t'] })).toBe(true);
    expect(gradeQuestion(trueFalse, { questionId: trueFalse.id, choiceIds: ['f'] })).toBe(false);
  });

  it('accepts any listed SHORT_TEXT answer, normalised', () => {
    expect(gradeQuestion(shortText, { questionId: shortText.id, text: ' 0X47 ' })).toBe(true);
    expect(gradeQuestion(shortText, { questionId: shortText.id, text: '47' })).toBe(true);
    expect(gradeQuestion(shortText, { questionId: shortText.id, text: '0x48' })).toBe(false);
  });

  it('marks empty SHORT_TEXT wrong', () => {
    expect(gradeQuestion(shortText, { questionId: shortText.id, text: '   ' })).toBe(false);
  });

  it('rejects a choice id that belongs to another question', () => {
    expect(gradeQuestion(single, { questionId: single.id, choiceIds: ['m1'] })).toBe(false);
  });
});

describe('gradeAttempt', () => {
  it('weights questions by their points', () => {
    // Only the 2-point MULTI is right: 2 of 5 points.
    const result = gradeAttempt(quiz, [{ questionId: multi.id, choiceIds: ['m1', 'm2'] }]);
    expect(result.totalPoints).toBe(5);
    expect(result.earnedPoints).toBe(2);
    expect(result.scorePercent).toBe(40);
    expect(result.passed).toBe(false);
  });

  it('passes at or above the passing score', () => {
    const result = gradeAttempt(quiz, [
      { questionId: single.id, choiceIds: ['c2'] },
      { questionId: multi.id, choiceIds: ['m1', 'm2'] },
      { questionId: trueFalse.id, choiceIds: ['t'] },
      { questionId: shortText.id, text: '0x47' },
    ]);
    expect(result.scorePercent).toBe(100);
    expect(result.passed).toBe(true);
  });

  it('scores unanswered questions as zero rather than excluding them', () => {
    // Answering only the question you know must not be a 100%.
    const result = gradeAttempt(quiz, [{ questionId: single.id, choiceIds: ['c2'] }]);
    expect(result.totalPoints).toBe(5);
    expect(result.scorePercent).toBe(20);
  });

  it('ignores answers for questions not in this quiz', () => {
    const result = gradeAttempt(quiz, [
      { questionId: single.id, choiceIds: ['c2'] },
      { questionId: 'q-from-another-quiz', choiceIds: ['whatever'] },
    ]);
    expect(result.outcomes).toHaveLength(4);
    expect(result.earnedPoints).toBe(1);
  });

  it('takes the last submission when a question is answered twice', () => {
    const result = gradeAttempt(quiz, [
      { questionId: single.id, choiceIds: ['c1'] },
      { questionId: single.id, choiceIds: ['c2'] },
    ]);
    expect(result.outcomes.find((o) => o.questionId === single.id)?.correct).toBe(true);
  });

  it('returns 0 and cannot pass an empty quiz', () => {
    const empty: GradableQuiz = { ...quiz, questions: [] };
    const result = gradeAttempt(empty, []);
    expect(result.scorePercent).toBe(0);
    expect(result.passed).toBe(false);
  });

  it('treats a non-positive point value as 1 instead of dividing by zero', () => {
    const zeroPoints: GradableQuiz = {
      ...quiz,
      questions: [{ ...single, points: 0 }],
    };
    const result = gradeAttempt(zeroPoints, [{ questionId: single.id, choiceIds: ['c2'] }]);
    expect(result.totalPoints).toBe(1);
    expect(result.scorePercent).toBe(100);
  });

  it('never reports a score outside 0-100', () => {
    for (const answers of [[], [{ questionId: multi.id, choiceIds: ['m1', 'm2'] }]]) {
      const result = gradeAttempt(quiz, answers);
      expect(result.scorePercent).toBeGreaterThanOrEqual(0);
      expect(result.scorePercent).toBeLessThanOrEqual(100);
    }
  });
});

describe('toStudentQuiz — the answer key never leaves the server', () => {
  it('exposes no key that could carry the answer', () => {
    const keys = collectKeys(toStudentQuiz(quiz));
    expect(keys.has('isCorrect')).toBe(false);
    expect(keys.has('acceptedAnswers')).toBe(false);
  });

  it('does not carry the answer in the serialized payload either', () => {
    // The projection is what the API sends; scanning the JSON catches a leak
    // that a key check could miss (an answer embedded in a label, say).
    const json = JSON.stringify(toStudentQuiz(quiz));
    expect(json).not.toContain('isCorrect');
    expect(json).not.toContain('acceptedAnswers');
    expect(json).not.toContain('0x47');
  });

  it('survives a new server-side field being added', () => {
    // The whole point of the explicit whitelist: an extra column on the source
    // object must not appear in the DTO on its own.
    const extended = {
      ...quiz,
      questions: quiz.questions.map((q) => ({ ...q, explanation: 'because the RFC says so' })),
    } as GradableQuiz;
    expect(collectKeys(toStudentQuiz(extended)).has('explanation')).toBe(false);
  });

  it('still sends everything the player needs to render', () => {
    const student = toStudentQuiz(quiz);
    expect(student.questions).toHaveLength(4);
    expect(student.questions[0]!.choices.map((c) => c.label)).toEqual(['404', '409', '500']);
    // A free-text question has no choices to reveal.
    expect(student.questions[3]!.choices).toEqual([]);
  });
});
