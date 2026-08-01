import './globals.css';
import './learn.css';
import './console.css';
import type { Metadata, Viewport } from 'next';
import { IBM_Plex_Sans, JetBrains_Mono, Source_Serif_4 } from 'next/font/google';
import type { ReactNode } from 'react';

/**
 * Three faces, chosen for the two surfaces.
 *
 * Source Serif 4 sets lesson prose and headings. A student on this page is
 * reading continuously for twenty minutes, and a serif with real optical sizing
 * is measurably easier to stay in than a grotesque tuned for interface labels.
 * It is a variable font, so `axes: ['opsz']` gives the same face a different
 * shape at 17px and at 52px.
 *
 * IBM Plex Sans does the interface: nav, buttons, form labels, and every word
 * in the console. Neutral on purpose — it should not be noticed.
 *
 * JetBrains Mono carries figures a reader compares rather than reads: lesson
 * durations, quiz scores, certificate serials, rendition bitrates, the console's
 * column headers. Proportional digits do not line up in a column, and lining up
 * is the entire job.
 *
 * All three are self-hosted by next/font at build time, so no runtime request
 * leaves for a font CDN.
 */
const display = Source_Serif_4({
  subsets: ['latin'],
  // No `weight`: passing one makes next/font emit static instances and `axes`
  // is rejected for those. Omitting it ships the variable face, so the weight
  // axis stays continuous and the optical-size axis comes along with it.
  axes: ['opsz'],
  variable: '--font-display',
  display: 'swap',
});
const ui = IBM_Plex_Sans({
  subsets: ['latin'],
  weight: ['400', '500', '600'],
  variable: '--font-ui',
  display: 'swap',
});
const mono = JetBrains_Mono({
  subsets: ['latin'],
  weight: ['400', '500'],
  variable: '--font-mono',
  display: 'swap',
});

export const metadata: Metadata = {
  title: 'LMS',
  description:
    'A learning platform with AES-128 encrypted adaptive streaming and progress that cannot be faked.',
};

/**
 * Matches the browser chrome to the page.
 *
 * Both values are the Console `--bg`, because that is what the document element
 * paints; the Learn scope repaints its own subtree. Without this, a mobile
 * browser draws its address bar in the default colour and the page appears to
 * float on a differently-coloured strip.
 */
export const viewport: Viewport = {
  themeColor: [
    { media: '(prefers-color-scheme: dark)', color: '#0b1220' },
    { media: '(prefers-color-scheme: light)', color: '#f8fafc' },
  ],
};

/**
 * The root layout owns only what is genuinely global: the document, the fonts
 * and the stylesheets.
 *
 * The chrome lives one level down, in the two route groups. `(learn)` and
 * `(console)` each render their own `<Nav>` inside their own `data-surface`
 * wrapper, so the nav takes the palette of the surface it sits on. Hoisting it
 * here would paint a warm page with a monochrome bar across the top.
 *
 * Route groups do not appear in the URL, so every existing route, link and test
 * selector is unaffected by the split.
 */
export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${display.variable} ${ui.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
