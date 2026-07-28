export interface CourseCompletedInput {
  studentName: string;
  courseTitle: string;
  serial: string;
  verifyUrl: string;
}

export interface TranscodeFailedInput {
  instructorName: string;
  courseTitle: string;
  lessonTitle: string;
  reason: string;
  lessonUrl: string;
}

/**
 * Plain text only, deliberately.
 *
 * An HTML template needs escaping, and a course title is user input that lands
 * in the middle of it. Text has no injection surface, renders in every client,
 * and is what a transactional message of three sentences actually needs.
 */
export function courseCompleted(input: CourseCompletedInput): { subject: string; text: string } {
  return {
    subject: `Your certificate for ${input.courseTitle}`,
    text: [
      `${input.studentName},`,
      '',
      `You have completed ${input.courseTitle}.`,
      '',
      `Certificate serial: ${input.serial}`,
      `Anyone can check it at ${input.verifyUrl}`,
      '',
      'Sign in to download the PDF.',
    ].join('\n'),
  };
}

export function transcodeFailed(input: TranscodeFailedInput): { subject: string; text: string } {
  return {
    subject: `Transcode failed: ${input.lessonTitle}`,
    text: [
      `${input.instructorName},`,
      '',
      `The video for "${input.lessonTitle}" in ${input.courseTitle} could not be processed.`,
      '',
      `Reason: ${input.reason}`,
      '',
      `Re-upload it at ${input.lessonUrl}`,
    ].join('\n'),
  };
}
