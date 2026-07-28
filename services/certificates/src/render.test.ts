import { describe, expect, it } from 'vitest';
import { formatDate, renderCertificate, type CertificateData } from './render';

const data: CertificateData = {
  serial: 'LMS-ABCD-EFGH-JKMN',
  studentName: 'Ada Lovelace',
  courseTitle: 'Adaptive Video Streaming from First Principles',
  instructorName: 'Grace Hopper',
  issuedAt: new Date('2026-07-28T00:00:00Z'),
  verifyUrl: 'http://localhost:3000/verify/LMS-ABCD-EFGH-JKMN',
};

describe('renderCertificate', () => {
  it('produces a real PDF', async () => {
    const pdf = await renderCertificate(data);
    // The magic number, not just "some bytes came back".
    expect(pdf.subarray(0, 5).toString('latin1')).toBe('%PDF-');
    expect(pdf.subarray(-6).toString('latin1')).toContain('%%EOF');
    expect(pdf.byteLength).toBeGreaterThan(1_000);
  });

  it('is deterministic for the same input', async () => {
    // The CreationDate is taken from issuedAt rather than the clock, which is
    // what makes a byte-for-byte comparison possible at all.
    const [first, second] = await Promise.all([renderCertificate(data), renderCertificate(data)]);
    expect(first.equals(second)).toBe(true);
  });

  it('changes when the serial changes', async () => {
    const other = await renderCertificate({ ...data, serial: 'LMS-PQRT-UVWX-Y234' });
    const original = await renderCertificate(data);
    expect(other.equals(original)).toBe(false);
  });

  it('survives a very long name and title without throwing', async () => {
    // Real submissions include pasted job titles and course names with
    // subtitles; the layout has to wrap rather than fail.
    const pdf = await renderCertificate({
      ...data,
      studentName: 'Maria '.repeat(20).trim(),
      courseTitle: 'A course title that goes on '.repeat(10).trim(),
    });
    expect(pdf.byteLength).toBeGreaterThan(1_000);
  });
});

describe('formatDate', () => {
  it('is unambiguous across locales', () => {
    expect(formatDate(new Date('2026-03-04T12:00:00Z'))).toBe('2026-03-04');
  });
});
