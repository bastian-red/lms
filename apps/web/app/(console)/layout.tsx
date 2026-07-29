import type { ReactNode } from 'react';
import { Nav } from '../../components/nav';

/**
 * The instructor and admin surfaces.
 *
 * `data-surface="console"` keeps the Nothing language: monochrome, hairline
 * seams, mono metadata, radius 0. That is not inertia — the retention charts
 * and the roster are the two screens where dense and unfussy is the right
 * answer, and softening them would cost real scanning speed.
 */
export default function ConsoleLayout({ children }: { children: ReactNode }) {
  return (
    <div data-surface="console">
      <a href="#content" className="skip-link">
        Skip to content
      </a>
      <Nav />
      <div id="content">{children}</div>
    </div>
  );
}
