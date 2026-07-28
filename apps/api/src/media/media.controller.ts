import {
  Controller,
  Get,
  Header,
  Inject,
  NotFoundException,
  Param,
  Query,
  Res,
  UseGuards,
} from '@nestjs/common';
import { SkipThrottle, Throttle } from '@nestjs/throttler';
import {
  MASTER_PLAYLIST,
  MediaPathError,
  openWithin,
  resolveWithin,
  rewriteMasterPlaylist,
  rewriteMediaPlaylist,
} from '@lms/media';
import { readFile } from 'node:fs/promises';
import type { Response } from 'express';
import { ManifestAuthGuard } from './manifest-auth.guard';
import { CurrentUser, type CurrentUserInfo } from '../auth/current-user.decorator';
import { CONFIG, RATE_LIMITS, type AppConfig } from '../config/config';
import { MediaAccessService } from './media-access.service';

/**
 * The four playback routes.
 *
 * Nothing under MEDIA_ROOT is statically served. Every playlist, every segment
 * and the key itself comes through here, which is what makes "copy the URL and
 * share it" not work and "copy the directory" not work either.
 *
 * The manifest route is the only one behind a service token. The other three
 * are authenticated by the ticket instead, because they are fetched by the
 * video element rather than by application code and cannot carry a bearer
 * header.
 */
const MEDIA_RATE_LIMIT = { default: { limit: RATE_LIMITS.media, ttl: 60_000 } };

@Throttle(MEDIA_RATE_LIMIT)
@Controller('lessons/:lessonId')
export class MediaController {
  constructor(
    private readonly access: MediaAccessService,
    @Inject(CONFIG) private readonly config: AppConfig,
  ) {}

  /**
   * The master playlist, with every variant URI rewritten to carry a freshly
   * minted ticket.
   *
   * This is the one place a ticket is created, and it is behind the normal
   * bearer-token guard with a full enrollment check. Everything downstream
   * inherits its authority from here.
   */
  @UseGuards(ManifestAuthGuard)
  @Get('manifest.m3u8')
  @Header('Content-Type', 'application/vnd.apple.mpegurl')
  // A manifest fetched from cache would carry a ticket that is minutes or hours
  // old, and, worse, a shared cache could hand one user's ticket to another.
  @Header('Cache-Control', 'no-store')
  async manifest(
    @Param('lessonId') lessonId: string,
    @CurrentUser() user: CurrentUserInfo,
  ): Promise<string> {
    const asset = await this.access.assertCanWatch(user.id, lessonId);
    const ticket = this.access.mintTicket(user.id, lessonId);

    const text = await this.readMediaFile(asset.outputDir, MASTER_PLAYLIST);
    return rewriteMasterPlaylist(text, (variantPath) => {
      // ffmpeg writes "720p/index.m3u8"; the route takes the rung and the file
      // as separate parameters so each is validated on its own.
      const [rendition = '', file = ''] = variantPath.split('/');
      return this.absolute(
        `/lessons/${encodeURIComponent(lessonId)}/rendition/${encodeURIComponent(rendition)}/${encodeURIComponent(file)}?t=${encodeURIComponent(ticket)}`,
      );
    });
  }

  /** A media playlist, with segment and key URIs rewritten. */
  @Get('rendition/:rendition/:file')
  @Header('Content-Type', 'application/vnd.apple.mpegurl')
  @Header('Cache-Control', 'no-store')
  async rendition(
    @Param('lessonId') lessonId: string,
    @Param('rendition') rendition: string,
    @Param('file') file: string,
    @Query('t') ticket: string,
  ): Promise<string> {
    const userId = this.access.requireTicket(ticket, lessonId);
    const asset = await this.access.assertCanWatch(userId, lessonId);

    const text = await this.readMediaFile(asset.outputDir, rendition, file);
    const base = `/lessons/${encodeURIComponent(lessonId)}`;
    const query = `?t=${encodeURIComponent(ticket)}`;

    return rewriteMediaPlaylist(text, {
      segmentUrl: (segment) =>
        this.absolute(
          `${base}/segment/${encodeURIComponent(rendition)}/${encodeURIComponent(segment)}${query}`,
        ),
      keyUrl: this.absolute(`${base}/key${query}`),
    });
  }

  /**
   * One encrypted segment.
   *
   * Ticket only, no enrollment re-read, and that is deliberate: these bytes are
   * ciphertext and worthless without the key. Adding a query per segment would
   * put the database in the playback path at 150 requests per lesson to protect
   * data that is already unreadable.
   */
  @Get('segment/:rendition/:file')
  async segment(
    @Param('lessonId') lessonId: string,
    @Param('rendition') rendition: string,
    @Param('file') file: string,
    @Query('t') ticket: string,
    @Res() response: Response,
  ): Promise<void> {
    const userId = this.access.requireTicket(ticket, lessonId);
    const asset = await this.access.assertCanWatch(userId, lessonId);

    // openMediaFile validates every path component and refuses anything that
    // escapes the media root, so `rendition` and `file` coming straight off the
    // URL is safe here and nowhere else.
    const stream = this.openMediaFile(asset.outputDir, rendition, file);

    response.setHeader('Content-Type', 'video/mp2t');
    // Segments are immutable and named by index, so a long browser cache is
    // correct and saves a request per seek. The ticket in the URL means a cached
    // entry is already scoped to one user and one lesson.
    response.setHeader('Cache-Control', 'private, max-age=3600');

    stream.on('error', () => {
      if (!response.headersSent) response.status(404).json({ message: 'Segment not found' });
      else response.end();
    });
    stream.pipe(response);
  }

  /**
   * The AES-128 content key.
   *
   * The only route that re-reads the enrollment, and the reason revocation is
   * immediate rather than eventual. `assertCanWatch` runs against the live
   * database, so a student revoked one second ago is refused here even though
   * the ticket in their hand is still cryptographically valid.
   *
   * Never rate limited away and never cached: hls.js re-fetches it whenever the
   * key line changes, and a cached 200 would be exactly the stale authorisation
   * this design exists to avoid.
   */
  @SkipThrottle()
  @Get('key')
  async key(
    @Param('lessonId') lessonId: string,
    @Query('t') ticket: string,
    @Res() response: Response,
  ): Promise<void> {
    const userId = this.access.requireTicket(ticket, lessonId);
    const asset = await this.access.assertCanWatch(userId, lessonId);

    response.setHeader('Content-Type', 'application/octet-stream');
    response.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    response.setHeader('Pragma', 'no-cache');
    response.send(asset.encryptionKey);
  }

  /** Read a file under the asset's output directory, or 404. */
  private async readMediaFile(outputDir: string, ...parts: string[]): Promise<string> {
    try {
      return await readFile(
        resolveWithin(this.config.media.root, ...outputDir.split('/'), ...parts),
        'utf8',
      );
    } catch (error) {
      if (error instanceof MediaPathError) throw new NotFoundException('Not found');
      throw new NotFoundException('Playlist not found');
    }
  }

  private openMediaFile(outputDir: string, ...parts: string[]) {
    try {
      return openWithin(this.config.media.root, ...outputDir.split('/'), ...parts);
    } catch (error) {
      if (error instanceof MediaPathError) throw new NotFoundException('Segment not found');
      throw error;
    }
  }

  /**
   * Absolute URLs in the playlist.
   *
   * A relative URI would be resolved by the player against the *playlist's* URL,
   * which already carries a query string, and browsers differ on how they
   * combine the two. Emitting absolute URLs removes the ambiguity.
   */
  private absolute(path: string): string {
    return `${this.config.apiBaseUrl}${path}`;
  }
}
