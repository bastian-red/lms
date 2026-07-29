import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { CERTIFICATE_FONTS, CERTIFICATE_TOKENS } from './tokens';
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

describe('design tokens', () => {
  it('uses the light-scheme values from the web design system', () => {
    // A certificate is always ink on paper, so it takes the light palette. These
    // are the same values as --text / --muted / --accent / --state-pass in
    // apps/web/app/globals.css, and apps/web/lib/contrast.test.ts proves they
    // clear AA on white. Drifting from them means the PDF and the page a reader
    // verifies it on stop looking like the same document.
    expect(CERTIFICATE_TOKENS).toEqual({
      ink: '#000000',
      inkMuted: '#5f5f5f',
      accent: '#ff0000',
      valid: '#04502c',
    });
  });

  it('embeds no fonts, so the file stays portable', () => {
    // pdfkit built-ins only. Embedding Space Grotesk would roughly double the
    // file for a document nobody reads on screen at display size.
    expect(Object.values(CERTIFICATE_FONTS).every((face) => face.startsWith('Helvetica'))).toBe(
      true,
    );
  });

  it('has no colour literals left in the renderer', () => {
    // Guards the half-done refactor: introducing the tokens but leaving one
    // `fillColor('#666666')` behind would satisfy the equality check above and
    // still print the old grey. Asserting on the rendered bytes cannot catch it
    // — pdfkit deflates its content streams, so no fill command survives as
    // readable text — so the guard is on the source instead.
    const source = readFileSync(join(__dirname, 'render.ts'), 'utf8');
    const literals = source.match(/#[0-9a-fA-F]{3,8}\b/g) ?? [];
    expect(literals, 'colours belong in ./tokens.ts').toEqual([]);
  });
});
