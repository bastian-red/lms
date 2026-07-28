import { ForbiddenException, Inject, Injectable, NotFoundException } from '@nestjs/common';
import { issueTicket, verifyTicket, type TicketFailure } from '@lms/shared';
import { CONFIG, type AppConfig } from '../config/config';
import { PrismaService } from '../prisma/prisma.service';

/**
 * The authorization layer in front of every byte of video.
 *
 * Two mechanisms, doing two different jobs, and the distinction is the whole
 * design:
 *
 *   **The ticket** is a stateless HMAC bound to (user, lesson, expiry). It rides
 *   in the URL because hls.js issues its own requests for playlists, segments
 *   and keys, and there is no portable way to attach an Authorization header to
 *   all of them. Verifying it costs one HMAC and no database round trip, which
 *   matters when a ten-minute lesson is 150 segment requests.
 *
 *   **The enrollment re-read** happens on the key endpoint only, and it is what
 *   makes access *live*. A ticket, once minted, is valid until it expires; if
 *   that were the only check, revoking a student would take up to two hours to
 *   bite. Because the key is fetched again whenever the `#EXT-X-KEY` line
 *   changes and is never cached (`Cache-Control: no-store`), a revocation stops
 *   playback within one key fetch — with the still-valid ticket in hand.
 *
 * Segments deliberately do *not* re-read the enrollment: they are ciphertext,
 * useless without the key, and paying a query per segment would put the database
 * in the playback path for no security gain.
 */

export interface AssetAccess {
  lessonId: string;
  assetId: string;
  outputDir: string;
  durationSeconds: number;
  encryptionKey: Buffer;
  encryptionIv: Buffer;
}

@Injectable()
export class MediaAccessService {
  constructor(
    private readonly prisma: PrismaService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  mintTicket(userId: string, lessonId: string): string {
    return issueTicket(userId, lessonId, this.config.authSecret, this.config.ticketTtlMinutes);
  }

  /**
   * Verify a ticket for this lesson. Returns the user id it was minted for.
   *
   * The user is not passed in, because the segment and key routes have no
   * authenticated principal: the ticket *is* the principal. That is safe
   * precisely because the ticket is bound to a user id, which is then what the
   * enrollment re-read keys on.
   */
  requireTicket(ticket: string | undefined, lessonId: string): string {
    const result = verifyTicket(ticket, { lessonId }, this.config.authSecret);
    if (!result.ok) {
      throw new ForbiddenException(ticketMessage(result.reason));
    }
    return result.claims.sub;
  }

  /**
   * Can this user watch this lesson right now?
   *
   * Three ways to be allowed, and every one of them is checked against the
   * current state of the database rather than against anything the caller sent:
   *   - the lesson is a free preview on a published course;
   *   - the user is enrolled and the enrollment is ACTIVE or COMPLETED;
   *   - the user is the course's instructor (so an unpublished draft is
   *     previewable by the person building it).
   *
   * A REVOKED enrollment is refused. So is an ARCHIVED course for a student,
   * while still being visible to its instructor.
   */
  async assertCanWatch(userId: string, lessonId: string): Promise<AssetAccess> {
    const lesson = await this.prisma.lesson.findUnique({
      where: { id: lessonId },
      select: {
        id: true,
        published: true,
        isPreview: true,
        module: {
          select: {
            course: {
              select: {
                id: true,
                status: true,
                instructorId: true,
                enrollments: {
                  where: { userId },
                  select: { status: true },
                  take: 1,
                },
              },
            },
          },
        },
        videoAsset: {
          select: {
            id: true,
            status: true,
            outputDir: true,
            durationSeconds: true,
            encryptionKey: true,
            encryptionIv: true,
          },
        },
      },
    });

    // 404 rather than 403 for a missing lesson: distinguishing them would let
    // anyone enumerate which lesson ids exist.
    if (!lesson) throw new NotFoundException('Lesson not found');

    const course = lesson.module.course;
    const isInstructor = course.instructorId === userId;
    const enrollment = course.enrollments[0];
    const enrolled = enrollment?.status === 'ACTIVE' || enrollment?.status === 'COMPLETED';
    const previewable = lesson.isPreview && lesson.published && course.status === 'PUBLISHED';

    if (!isInstructor && !previewable) {
      if (!enrolled) throw new ForbiddenException('Not enrolled in this course');
      if (!lesson.published) throw new ForbiddenException('Lesson is not published');
      if (course.status !== 'PUBLISHED') throw new ForbiddenException('Course is not published');
    }

    const asset = lesson.videoAsset;
    if (!asset) throw new NotFoundException('This lesson has no video');
    if (asset.status !== 'READY') {
      throw new NotFoundException(`Video is not ready (status: ${asset.status})`);
    }
    // The database CHECK makes this unreachable for a READY asset; the guard is
    // here so a future migration that relaxes it fails loudly rather than
    // serving a null key.
    if (!asset.outputDir || !asset.encryptionKey || !asset.encryptionIv) {
      throw new NotFoundException('Video is not ready');
    }

    return {
      lessonId: lesson.id,
      assetId: asset.id,
      outputDir: asset.outputDir,
      durationSeconds: asset.durationSeconds,
      encryptionKey: Buffer.from(asset.encryptionKey),
      encryptionIv: Buffer.from(asset.encryptionIv),
    };
  }
}

/**
 * Why a ticket was refused, in words that help a developer and tell an attacker
 * nothing they did not already know. Every one of these is a 403; the message
 * distinguishes a clock problem from a forgery, which is the difference between
 * a five-minute fix and a day of confusion.
 */
function ticketMessage(reason: TicketFailure): string {
  switch (reason) {
    case 'expired':
      return 'Playback ticket has expired';
    case 'wrong-lesson':
      return 'Playback ticket is for a different lesson';
    case 'wrong-user':
      return 'Playback ticket was issued to a different account';
    default:
      return 'Invalid playback ticket';
  }
}
