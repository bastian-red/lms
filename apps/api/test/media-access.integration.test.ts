import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createDecipheriv } from 'node:crypto';
import { mediaConfigFromEnv, TS_SYNC_BYTE } from '@lms/media';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  api,
  apiBytes,
  firstSegmentUrl,
  loadFixture,
  prisma,
  resetStudent,
  serviceToken,
  ticketFrom,
  type SeedFixture,
} from './helpers';

/**
 * Properties 1 and 2 of the README, proved against the real stack.
 *
 *   1. Every segment on disk is AES-128 encrypted.
 *   2. Authorization is live: revoking a student stops playback on the next key
 *      fetch, with a still-valid ticket in hand.
 *
 * Both are properties nothing but an end-to-end test can establish. A unit test
 * of the transcoder proves the flags were passed; only reading the bytes proves
 * ffmpeg acted on them.
 */
describe('media access', () => {
  let fixture: SeedFixture;
  let token: string;
  const media = mediaConfigFromEnv();

  beforeAll(async () => {
    fixture = await loadFixture();
    await resetStudent(fixture);
    token = serviceToken(fixture.studentId, 'ada@lms.local', 'STUDENT');
  });

  afterAll(async () => {
    await resetStudent(fixture);
    await prisma.$disconnect();
  });

  describe('property 1: nothing on disk is playable', () => {
    it('every rendition ships segments that are not transport streams', async () => {
      const asset = await prisma.videoAsset.findFirstOrThrow({
        where: { lessonId: fixture.videoLessonId },
      });
      const renditions = asset.renditions as { name: string }[];
      expect(renditions.length).toBeGreaterThanOrEqual(1);

      for (const rendition of renditions) {
        const segment = await readFile(
          join(media.root, fixture.assetOutputDir, rendition.name, 'seg00000.ts'),
        );
        // 0x47 at every packet boundary is what makes a file a transport stream.
        // Ciphertext matching all four offsets is a one-in-four-billion event.
        for (const offset of [0, 188, 376, 564]) {
          if (segment.length > offset) {
            expect(segment[offset]).not.toBe(TS_SYNC_BYTE);
          }
        }
      }
    });

    it('the key is nowhere in the media directory', async () => {
      // The whole exercise is defeated if the directory an operator copies or
      // backs up contains both the ciphertext and the key that opens it.
      const asset = await prisma.videoAsset.findFirstOrThrow({
        where: { lessonId: fixture.videoLessonId },
      });
      const playlist = await readFile(
        join(media.root, fixture.assetOutputDir, '360p', 'index.m3u8'),
        'utf8',
      );
      expect(playlist).toContain('#EXT-X-KEY:METHOD=AES-128');
      // The playlist on disk carries the placeholder URI, never a real one.
      expect(playlist).toContain('lms-key://placeholder');
      expect(playlist).not.toContain(asset.encryptionKey!.toString('hex'));
    });

    it('a segment decrypts to a real transport stream with the served key', async () => {
      // The other half of the proof: encrypted is only useful if it is also
      // correct. Without this, a transcode that produced noise would pass the
      // "not 0x47" check perfectly.
      const manifest = await api<string>(`/lessons/${fixture.videoLessonId}/manifest.m3u8`, {
        token,
      });
      const ticket = ticketFrom(manifest.text);

      const playlist = await api<string>(
        `/lessons/${fixture.videoLessonId}/rendition/360p/index.m3u8?t=${ticket}`,
      );
      const iv = /IV=0x([0-9a-fA-F]+)/.exec(playlist.text)?.[1];
      expect(iv).toBeDefined();

      const key = await apiBytes(`/lessons/${fixture.videoLessonId}/key?t=${ticket}`);
      expect(key.status).toBe(200);
      expect(key.bytes).toHaveLength(16);

      const segmentUrl = new URL(firstSegmentUrl(playlist.text));
      const segment = await apiBytes(`${segmentUrl.pathname}${segmentUrl.search}`);
      expect(segment.bytes[0]).not.toBe(TS_SYNC_BYTE);

      const decipher = createDecipheriv('aes-128-cbc', key.bytes, Buffer.from(iv!, 'hex'));
      decipher.setAutoPadding(false);
      const plain = Buffer.concat([decipher.update(segment.bytes), decipher.final()]);
      expect(plain[0]).toBe(TS_SYNC_BYTE);
      expect(plain[188]).toBe(TS_SYNC_BYTE);
    });
  });

  describe('property 2: authorization is live, not a one-time gate', () => {
    it('revoking mid-playback refuses the very next key fetch', async () => {
      const manifest = await api<string>(`/lessons/${fixture.videoLessonId}/manifest.m3u8`, {
        token,
      });
      expect(manifest.status).toBe(200);
      const ticket = ticketFrom(manifest.text);

      // Playback is working.
      const before = await apiBytes(`/lessons/${fixture.videoLessonId}/key?t=${ticket}`);
      expect(before.status).toBe(200);

      await prisma.enrollment.update({
        where: {
          userId_courseId: { userId: fixture.studentId, courseId: fixture.courseId },
        },
        data: { status: 'REVOKED' },
      });

      // The same ticket. Not expired, not tampered with, still signed by the
      // server that issued it a second ago.
      const after = await apiBytes(`/lessons/${fixture.videoLessonId}/key?t=${ticket}`);
      expect(after.status).toBe(403);

      await resetStudent(fixture);
      const restored = await apiBytes(`/lessons/${fixture.videoLessonId}/key?t=${ticket}`);
      expect(restored.status).toBe(200);
    });

    it('the key response is never cacheable', async () => {
      // A cached 200 is exactly the stale authorisation this design exists to
      // avoid: the browser would keep decrypting after revocation.
      const manifest = await api<string>(`/lessons/${fixture.videoLessonId}/manifest.m3u8`, {
        token,
      });
      const ticket = ticketFrom(manifest.text);
      const key = await apiBytes(`/lessons/${fixture.videoLessonId}/key?t=${ticket}`);
      expect(key.headers.get('cache-control')).toContain('no-store');
    });
  });

  describe('the ticket', () => {
    it('is required', async () => {
      const response = await apiBytes(`/lessons/${fixture.videoLessonId}/key`);
      expect(response.status).toBe(403);
    });

    it('does not open a different lesson', async () => {
      // A ticket for the free preview must not unlock a paid lesson.
      const previewManifest = await api<string>(
        `/lessons/${fixture.previewLessonId}/manifest.m3u8`,
        { token },
      );
      const previewTicket = ticketFrom(previewManifest.text);

      const response = await apiBytes(
        `/lessons/${fixture.videoLessonId}/key?t=${previewTicket}`,
      );
      expect(response.status).toBe(403);
    });

    it('is rejected when tampered with', async () => {
      const manifest = await api<string>(`/lessons/${fixture.videoLessonId}/manifest.m3u8`, {
        token,
      });
      const ticket = ticketFrom(manifest.text);
      const tampered = `${ticket.slice(0, -4)}AAAA`;
      const response = await apiBytes(`/lessons/${fixture.videoLessonId}/key?t=${tampered}`);
      expect(response.status).toBe(403);
    });
  });

  describe('the manifest route', () => {
    it('refuses an anonymous request', async () => {
      const response = await api(`/lessons/${fixture.videoLessonId}/manifest.m3u8`);
      expect(response.status).toBe(401);
    });

    it('refuses a student who is not enrolled', async () => {
      const stranger = await prisma.user.create({
        data: {
          email: `stranger-${Date.now()}@lms.local`,
          name: 'Stranger',
          passwordHash: 'scrypt:00:00',
        },
      });
      try {
        const response = await api(`/lessons/${fixture.videoLessonId}/manifest.m3u8`, {
          token: serviceToken(stranger.id, stranger.email, 'STUDENT'),
        });
        expect(response.status).toBe(403);
      } finally {
        await prisma.user.delete({ where: { id: stranger.id } });
      }
    });

    it('lets anyone signed in watch the free preview', async () => {
      const stranger = await prisma.user.create({
        data: {
          email: `preview-${Date.now()}@lms.local`,
          name: 'Curious',
          passwordHash: 'scrypt:00:00',
        },
      });
      try {
        const response = await api<string>(
          `/lessons/${fixture.previewLessonId}/manifest.m3u8`,
          { token: serviceToken(stranger.id, stranger.email, 'STUDENT') },
        );
        expect(response.status).toBe(200);
        expect(response.text).toContain('#EXT-X-STREAM-INF');
      } finally {
        await prisma.user.delete({ where: { id: stranger.id } });
      }
    });

    it('advertises more than one rendition, which is what makes it adaptive', async () => {
      const manifest = await api<string>(`/lessons/${fixture.videoLessonId}/manifest.m3u8`, {
        token,
      });
      const variants = manifest.text.match(/#EXT-X-STREAM-INF:/g) ?? [];
      expect(variants.length).toBeGreaterThanOrEqual(2);
      expect(manifest.text).toMatch(/RESOLUTION=\d+x\d+/);
      expect(manifest.text).toMatch(/BANDWIDTH=\d+/);
    });
  });

  describe('path traversal', () => {
    it('refuses to serve anything outside the media root', async () => {
      const manifest = await api<string>(`/lessons/${fixture.videoLessonId}/manifest.m3u8`, {
        token,
      });
      const ticket = ticketFrom(manifest.text);

      for (const attempt of [
        `/lessons/${fixture.videoLessonId}/segment/..%2f..%2f..%2fetc/passwd?t=${ticket}`,
        `/lessons/${fixture.videoLessonId}/segment/360p/..%2f..%2f.env?t=${ticket}`,
        `/lessons/${fixture.videoLessonId}/rendition/..%2f..%2fetc/passwd?t=${ticket}`,
      ]) {
        const response = await apiBytes(attempt);
        expect(response.status).toBeGreaterThanOrEqual(400);
        expect(response.bytes.toString('utf8')).not.toContain('root:');
      }
    });
  });
});
