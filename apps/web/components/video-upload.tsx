'use client';

import { useRouter } from 'next/navigation';
import { useState } from 'react';

/**
 * Direct-to-API upload with a real progress bar.
 *
 * `XMLHttpRequest`, not `fetch`, and that is not nostalgia: `fetch` still has no
 * upload progress event in any shipping browser, and a 500MB video with no
 * feedback is indistinguishable from a hung page.
 *
 * The file goes straight to the API rather than through a Server Action.
 * Server Actions buffer the whole body in the Next process before forwarding it,
 * which doubles peak memory and adds a second copy of the bytes for no benefit.
 */
export function VideoUpload({
  lessonId,
  apiBaseUrl,
  token,
  lessonTitle,
}: {
  lessonId: string;
  apiBaseUrl: string;
  token: string;
  /** Which lesson this uploads to. The editor lists several at once, so
      "Choose file" alone does not say which one a screen reader is on. */
  lessonTitle: string;
}) {
  const router = useRouter();
  const [percent, setPercent] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);

  const upload = (file: File): void => {
    setError(null);
    setPercent(0);

    const body = new FormData();
    body.append('file', file);

    const request = new XMLHttpRequest();
    request.open('POST', `${apiBaseUrl}/instructor/lessons/${lessonId}/video`);
    request.setRequestHeader('authorization', `Bearer ${token}`);

    request.upload.addEventListener('progress', (event) => {
      if (event.lengthComputable) setPercent(Math.round((event.loaded / event.total) * 100));
    });
    request.addEventListener('load', () => {
      setPercent(null);
      if (request.status >= 200 && request.status < 300) {
        // The transcode is now queued. Refreshing shows PENDING immediately, and
        // the instructor polls by reloading — a websocket for a job that takes
        // minutes would be a lot of machinery for very little.
        router.refresh();
        return;
      }
      try {
        const body = JSON.parse(request.responseText) as { message?: string };
        setError(body.message ?? `Upload failed (${request.status})`);
      } catch {
        setError(`Upload failed (${request.status})`);
      }
    });
    request.addEventListener('error', () => {
      setPercent(null);
      setError('Upload failed. Check your connection and try again.');
    });

    request.send(body);
  };

  return (
    <div className="mt-2">
      <label className="sr-only" htmlFor={`upload-input-${lessonId}`}>
        Upload video for {lessonTitle}
      </label>
      <input
        id={`upload-input-${lessonId}`}
        type="file"
        accept="video/mp4,video/quicktime,video/x-matroska,video/webm"
        data-testid={`upload-${lessonId}`}
        disabled={percent !== null}
        onChange={(event) => {
          const file = event.target.files?.[0];
          if (file) upload(file);
        }}
      />
      {percent !== null ? (
        <div className="mt-2">
          <div className="progress-line">
            <span>Uploading…</span>
            <b>{percent}%</b>
          </div>
          {/* role=progressbar so the percentage is announced, not just drawn. */}
          <div
            className="meter"
            role="progressbar"
            aria-valuenow={percent}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-label={`Upload progress for ${lessonTitle}`}
          >
            <span style={{ width: `${percent}%` }} />
          </div>
        </div>
      ) : null}
      {error ? (
        <p className="job-error" data-testid={`upload-error-${lessonId}`}>
          {error}
        </p>
      ) : null}
    </div>
  );
}
