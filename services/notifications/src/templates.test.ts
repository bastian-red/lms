import { describe, expect, it } from 'vitest';
import { courseCompleted, transcodeFailed } from './templates';

describe('courseCompleted', () => {
  it('names the course and carries the serial', () => {
    const message = courseCompleted({
      studentName: 'Ada',
      courseTitle: 'Streaming',
      serial: 'LMS-ABCD-EFGH-JKMN',
      verifyUrl: 'http://localhost:3000/verify/LMS-ABCD-EFGH-JKMN',
    });
    expect(message.subject).toContain('Streaming');
    expect(message.text).toContain('LMS-ABCD-EFGH-JKMN');
    expect(message.text).toContain('http://localhost:3000/verify/');
  });

  it('does not interpolate into markup', () => {
    // Plain text has no injection surface, and this asserts nobody quietly
    // turned it into HTML.
    const message = courseCompleted({
      studentName: '<script>alert(1)</script>',
      courseTitle: 'X',
      serial: 'S',
      verifyUrl: 'U',
    });
    expect(message.text).not.toContain('<html');
    expect(message.text).toContain('<script>alert(1)</script>');
  });
});

describe('transcodeFailed', () => {
  it('tells the instructor which lesson and why', () => {
    const message = transcodeFailed({
      instructorName: 'Grace',
      courseTitle: 'Streaming',
      lessonTitle: 'Segment alignment',
      reason: 'ffmpeg exited with code 1',
      lessonUrl: 'http://localhost:3000/instructor/courses/c1',
    });
    expect(message.subject).toContain('Segment alignment');
    expect(message.text).toContain('ffmpeg exited with code 1');
    expect(message.text).toContain('http://localhost:3000/instructor/courses/c1');
  });
});
