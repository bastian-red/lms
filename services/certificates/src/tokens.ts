/**
 * The certificate's design tokens.
 *
 * A certificate is printed and archived, so it is the one surface with no dark
 * mode and no viewport: it is always ink on paper. The values are therefore the
 * *light* scheme's, taken from `apps/web/app/globals.css`, not a second palette
 * invented here — a student who verifies a serial should land on a page that
 * looks like the document in their hand.
 *
 * Why a copy at all rather than an import: `services/certificates` builds and
 * ships independently of `apps/web`, and reaching across that boundary to read
 * a stylesheet at runtime would couple a PDF renderer to a Next.js app for four
 * colours. The contract is the comment plus the test in render.test.ts, which
 * asserts these are the values the document actually uses.
 */

export const CERTIFICATE_TOKENS = {
  /** Body and rules. `--text` in the light scheme. */
  ink: '#000000',
  /** Secondary text: captions, the verify URL. `--muted` in the light scheme,
      which clears 4.5:1 on white — the old #666666 did not at 7pt. */
  inkMuted: '#5f5f5f',
  /** The brand signal, used only for the seal rule. `--accent`. */
  accent: '#ff0000',
  /** Confirms authenticity. `--state-pass` in the light scheme. */
  valid: '#04502c',
} as const;

/** pdfkit's built-in faces. No embedding, so the file stays small and portable. */
export const CERTIFICATE_FONTS = {
  body: 'Helvetica',
  bold: 'Helvetica-Bold',
} as const;
