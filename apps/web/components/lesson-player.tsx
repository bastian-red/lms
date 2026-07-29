'use client';

import type { LessonPlayback } from '@lms/shared/client';
import Hls, { type ErrorData, type Events } from 'hls.js';
import { useCallback, useEffect, useRef, useState } from 'react';
import { drain, emptySampler, sample, type SamplerState } from '../lib/watch-intervals';

/**
 * The video player.
 *
 * Three jobs, and each one is a place a naive implementation gets it wrong:
 *
 *  1. **Play the encrypted stream.** hls.js handles AES-128 natively once it can
 *     fetch the key, which it does from the URL the API rewrote into the
 *     playlist. Safari plays HLS natively and ignores hls.js entirely, so both
 *     paths exist.
 *
 *  2. **Report what was actually watched.** Not `currentTime` — the ranges
 *     covered. The player samples its own position on a timer and accumulates
 *     contiguous runs, breaking the run whenever a seek moves the position by
 *     more than a sample's worth. That is what makes dragging the scrubber
 *     produce two short intervals instead of one long one.
 *
 *  3. **Survive an expired ticket.** Tickets live two hours; a lesson left open
 *     over lunch outlives one. A 403 on a segment or key fetch re-fetches the
 *     manifest, which mints a fresh ticket, and playback resumes at the same
 *     position instead of stalling forever with no explanation.
 */

/** How often the position is sampled, in milliseconds. */
const SAMPLE_MS = 1_000;
/** How often accumulated intervals are posted to the server. */
const BEAT_MS = 10_000;

interface Props {
  lesson: LessonPlayback;
  /** Short-lived service token used only to fetch the manifest. */
  token: string;
  onProgress?: (progress: { secondsWatched: number; completed: boolean; clamped: boolean }) => void;
  apiBaseUrl: string;
}

export function LessonPlayer({ lesson, token, onProgress, apiBaseUrl }: Props) {
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const hlsRef = useRef<Hls | null>(null);

  // A ref, not state: the sampler is advanced by a 1s timer and must not
  // re-render the component sixty times a minute. The reducer itself lives in
  // lib/watch-intervals.ts, where it is unit tested without a browser.
  const samplerRef = useRef<SamplerState>(emptySampler());

  const [level, setLevel] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [watched, setWatched] = useState(lesson.secondsWatched);

  /** Post whatever has accumulated. */
  const flush = useCallback(async () => {
    // Drained before the await, so an interval sampled while the request is in
    // flight belongs to the next beat rather than being dropped.
    const { intervals, state } = drain(samplerRef.current);
    samplerRef.current = state;
    if (intervals.length === 0) return;

    try {
      const response = await fetch(`${apiBaseUrl}/lessons/${lesson.lessonId}/progress`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
        body: JSON.stringify({ intervals }),
      });
      if (!response.ok) return;
      const result = (await response.json()) as {
        secondsWatched: number;
        completed: boolean;
        clamped: boolean;
      };
      setWatched(result.secondsWatched);
      onProgress?.(result);
    } catch {
      // A failed beat is not worth surfacing: the next one carries the same
      // ground the player has covered since, because coverage is a union.
    }
  }, [apiBaseUrl, lesson.lessonId, onProgress, token]);

  // ---- Attach the stream -------------------------------------------------
  useEffect(() => {
    const video = videoRef.current;
    if (!video || !lesson.manifestUrl) return;

    const manifestUrl = `${lesson.manifestUrl}?token=${encodeURIComponent(token)}`;

    if (Hls.isSupported()) {
      const hls = new Hls({
        // The manifest is the only request that needs the bearer token; every
        // request after it carries a ticket in the URL that the API rewrote in.
        xhrSetup: (xhr, url) => {
          if (url.includes('/manifest.m3u8')) {
            xhr.setRequestHeader('authorization', `Bearer ${token}`);
          }
        },
        enableWorker: true,
        lowLatencyMode: false,
      });
      hlsRef.current = hls;

      hls.on(Hls.Events.LEVEL_SWITCHED as Events.LEVEL_SWITCHED, (_event, data) => {
        const height = hls.levels[data.level]?.height;
        setLevel(height ? `${height}p` : null);
      });

      hls.on(Hls.Events.ERROR as Events.ERROR, (_event, data: ErrorData) => {
        const status = data.response?.code;
        if (status === 403) {
          // Either the ticket expired or access was revoked. Reloading the
          // manifest distinguishes the two: it mints a fresh ticket if the
          // student is still enrolled, and 403s again if they are not.
          setError('Re-authorising…');
          hls.loadSource(manifestUrl);
          return;
        }
        if (!data.fatal) return;
        switch (data.type) {
          case Hls.ErrorTypes.NETWORK_ERROR:
            hls.startLoad();
            break;
          case Hls.ErrorTypes.MEDIA_ERROR:
            hls.recoverMediaError();
            break;
          default:
            setError('This video could not be played.');
            hls.destroy();
        }
      });

      hls.on(Hls.Events.MANIFEST_PARSED as Events.MANIFEST_PARSED, () => setError(null));
      hls.loadSource(manifestUrl);
      hls.attachMedia(video);

      return () => {
        hls.destroy();
        hlsRef.current = null;
      };
    }

    if (video.canPlayType('application/vnd.apple.mpegurl')) {
      // Safari. It plays HLS and handles AES-128 itself, but it cannot send an
      // Authorization header, so the token rides in the query string, which the
      // manifest route accepts for exactly this case.
      video.src = manifestUrl;
      return;
    }

    setError('This browser cannot play HLS video.');
    return;
  }, [lesson.manifestUrl, token]);

  // ---- Sample the position ----------------------------------------------
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const sampler = setInterval(() => {
      const playing = !video.paused && !video.seeking && !video.ended;
      samplerRef.current = sample(samplerRef.current, video.currentTime, playing);
    }, SAMPLE_MS);

    const beat = setInterval(() => void flush(), BEAT_MS);

    // A student who closes the tab mid-lesson must not lose the last ten
    // seconds. `pagehide` fires where `beforeunload` does not on mobile Safari.
    const onLeave = (): void => void flush();
    window.addEventListener('pagehide', onLeave);
    video.addEventListener('pause', onLeave);

    return () => {
      clearInterval(sampler);
      clearInterval(beat);
      window.removeEventListener('pagehide', onLeave);
      video.removeEventListener('pause', onLeave);
      void flush();
    };
  }, [flush]);

  const percent =
    lesson.durationSeconds > 0 ? Math.min(100, (watched / lesson.durationSeconds) * 100) : 0;

  return (
    <div>
      <div className="player-frame">
        <video ref={videoRef} controls playsInline preload="metadata" data-testid="lesson-video" />
      </div>
      <div className="player-bar">
        <span data-testid="rendition-readout" className="rendition-readout">
          Rendition
          {lesson.renditions.map((rendition) => (
            <span
              key={rendition.name}
              className={`rendition-pill${level === rendition.name ? ' active' : ''}`}
            >
              {rendition.name}
            </span>
          ))}
        </span>
        <span>
          Watched <strong data-testid="seconds-watched">{Math.floor(watched)}</strong> /{' '}
          {Math.floor(lesson.durationSeconds)}s
        </span>
      </div>
      <div className="mt-4">
        <div className="progress-line">
          <span>Coverage</span>
          <b data-testid="coverage-percent">{percent.toFixed(0)}%</b>
        </div>
        <div className="meter">
          <span style={{ width: `${percent}%` }} />
        </div>
      </div>
      {error ? (
        <p className="notice" data-testid="player-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}
