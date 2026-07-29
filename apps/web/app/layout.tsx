import './globals.css';
import './learn.css';
import './console.css';
import type { Metadata, Viewport } from 'next';
import { Space_Grotesk, Space_Mono } from 'next/font/google';
import localFont from 'next/font/local';
import type { ReactNode } from 'react';

// A grotesk for display and body, a mono for metadata, a dot-matrix face for the
// brand mark and numbers. All three are self-hosted by next/font at build time,
// so no runtime request leaves for a font CDN.
const grotesk = Space_Grotesk({
  subsets: ['latin'],
  weight: ['400', '500', '700'],
  variable: '--font-display',
  display: 'swap',
});
const mono = Space_Mono({
  subsets: ['latin'],
  weight: ['400', '700'],
  variable: '--font-mono',
  display: 'swap',
});
const doto = localFont({
  src: './fonts/doto.woff2',
  weight: '100 900',
  variable: '--font-dot',
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
    { media: '(prefers-color-scheme: dark)', color: '#000000' },
    { media: '(prefers-color-scheme: light)', color: '#ffffff' },
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
    <html lang="en" className={`${grotesk.variable} ${mono.variable} ${doto.variable}`}>
      <body>{children}</body>
    </html>
  );
}
