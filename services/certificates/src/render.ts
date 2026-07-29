import { mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import PDFDocument from 'pdfkit';
import { CERTIFICATE_FONTS, CERTIFICATE_TOKENS } from './tokens';

/**
 * Certificate PDF rendering.
 *
 * pdfkit rather than a headless browser. Puppeteer would render nicer type, but
 * it drags a full Chromium into the API image for one page of static layout,
 * and it is one more process that can hang while a student waits for a
 * download. This produces a deterministic file with a library that is already a
 * plain Node dependency.
 *
 * The layout is intentionally the Nothing design language the rest of the app
 * uses: monochrome, wide letter-spacing, a rule under the title, everything
 * left-aligned to a single grid.
 */

export interface CertificateData {
  serial: string;
  studentName: string;
  courseTitle: string;
  instructorName: string;
  issuedAt: Date;
  /** Public URL a reader can check the serial against. */
  verifyUrl: string;
}

const A4_LANDSCAPE: [number, number] = [841.89, 595.28];
const MARGIN = 56;

/** Render the certificate and resolve with the complete PDF bytes. */
export function renderCertificate(data: CertificateData): Promise<Buffer> {
  return new Promise((resolvePromise, rejectPromise) => {
    const doc = new PDFDocument({
      size: A4_LANDSCAPE,
      margin: MARGIN,
      // Written into the file's metadata, so a downloaded certificate is
      // identifiable without opening it.
      info: {
        Title: `Certificate ${data.serial}`,
        Author: 'LMS',
        Subject: data.courseTitle,
        Keywords: data.serial,
        // Fixed rather than "now": a deterministic file is one a test can hash,
        // and the issue date is already on the page.
        CreationDate: data.issuedAt,
      },
      autoFirstPage: true,
    });

    const chunks: Buffer[] = [];
    doc.on('data', (chunk: Buffer) => chunks.push(chunk));
    doc.on('end', () => resolvePromise(Buffer.concat(chunks)));
    doc.on('error', rejectPromise);

    draw(doc, data);
    doc.end();
  });
}

function draw(doc: PDFKit.PDFDocument, data: CertificateData): void {
  const width = A4_LANDSCAPE[0] - MARGIN * 2;
  const height = A4_LANDSCAPE[1];

  // Border, inset from the margin. Two rules rather than a box so the corners
  // stay square at print resolution.
  doc.lineWidth(1).strokeColor(CERTIFICATE_TOKENS.ink);
  doc.rect(MARGIN / 2, MARGIN / 2, A4_LANDSCAPE[0] - MARGIN, height - MARGIN).stroke();

  doc
    .fillColor(CERTIFICATE_TOKENS.ink)
    .font(CERTIFICATE_FONTS.body)
    .fontSize(9)
    .text('CERTIFICATE OF COMPLETION', MARGIN, MARGIN + 10, {
      width,
      characterSpacing: 4,
    });

  doc
    .moveTo(MARGIN, MARGIN + 32)
    .lineTo(MARGIN + width, MARGIN + 32)
    .stroke();

  doc.font(CERTIFICATE_FONTS.body).fontSize(11).text('This certifies that', MARGIN, MARGIN + 66, { width });

  // The name is the only thing on the page set large. Long names wrap rather
  // than overflow the border, which is why the width is bounded and lineBreak
  // stays on.
  doc
    .font(CERTIFICATE_FONTS.bold)
    .fontSize(34)
    .text(data.studentName, MARGIN, MARGIN + 88, { width, lineBreak: true });

  doc
    .font(CERTIFICATE_FONTS.body)
    .fontSize(11)
    .text('has completed every lesson and passed every assessment in', MARGIN, MARGIN + 150, {
      width,
    });

  doc
    .font(CERTIFICATE_FONTS.bold)
    .fontSize(22)
    .text(data.courseTitle, MARGIN, MARGIN + 172, { width, lineBreak: true });

  const footerTop = height - MARGIN - 96;
  doc
    .moveTo(MARGIN, footerTop)
    .lineTo(MARGIN + width, footerTop)
    .stroke();

  const columnWidth = width / 3 - 12;
  const label = (text: string, x: number, y: number): void => {
    doc.font(CERTIFICATE_FONTS.body).fontSize(7).fillColor(CERTIFICATE_TOKENS.inkMuted).text(text, x, y, {
      width: columnWidth,
      characterSpacing: 2,
    });
  };
  const value = (text: string, x: number, y: number): void => {
    doc
      .font(CERTIFICATE_FONTS.bold)
      .fontSize(11)
      .fillColor(CERTIFICATE_TOKENS.ink)
      .text(text, x, y, { width: columnWidth });
  };

  label('ISSUED', MARGIN, footerTop + 16);
  value(formatDate(data.issuedAt), MARGIN, footerTop + 28);

  label('INSTRUCTOR', MARGIN + width / 3, footerTop + 16);
  value(data.instructorName, MARGIN + width / 3, footerTop + 28);

  label('SERIAL', MARGIN + (width / 3) * 2, footerTop + 16);
  value(data.serial, MARGIN + (width / 3) * 2, footerTop + 28);

  doc
    .font(CERTIFICATE_FONTS.body)
    .fontSize(8)
    .fillColor(CERTIFICATE_TOKENS.inkMuted)
    .text(`Verify at ${data.verifyUrl}`, MARGIN, footerTop + 62, { width });
}

/**
 * ISO-ish, UTC, unambiguous. A locale-formatted date on a document that crosses
 * borders is the 03/04 problem waiting to happen.
 */
export function formatDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Render and write to disk, creating the parent directory. */
export async function writeCertificate(
  absolutePath: string,
  data: CertificateData,
): Promise<Buffer> {
  const pdf = await renderCertificate(data);
  await mkdir(dirname(absolutePath), { recursive: true });
  await writeFile(absolutePath, pdf);
  return pdf;
}
