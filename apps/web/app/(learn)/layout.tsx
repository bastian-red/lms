import type { ReactNode } from 'react';
import { Nav } from '../../components/nav';

/**
 * The student surfaces: catalogue, course, player, quiz, certificate, auth.
 *
 * `data-surface="learn"` is what learn.css hangs every token override off. The
 * skip link is here rather than in the root layout because it targets
 * `#content`, and this is the layout that owns that landmark.
 */
export default function LearnLayout({ children }: { children: ReactNode }) {
  return (
    <div data-surface="learn">
      <a href="#content" className="skip-link">
        Skip to content
      </a>
      <Nav />
      <div id="content">{children}</div>
    </div>
  );
}
