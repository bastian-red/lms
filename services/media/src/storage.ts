import { constants } from 'node:fs';
import { access, mkdir, stat, writeFile } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { Readable } from 'node:stream';
import type { MediaConfig } from './config';
import { isSafePathSegment } from './playlist';

/**
 * Filesystem access for everything under MEDIA_ROOT.
 *
 * One module owns path construction, and it is the only place allowed to turn a
 * request parameter into a filesystem path. Every read goes through
 * `resolveWithin`, which resolves the candidate and then proves the result is
 * still inside the root. Validating the input alone is not enough: symlinks,
 * unicode normalisation and double decoding all produce a string that passes a
 * pattern check and resolves somewhere else.
 */

export class MediaPathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MediaPathError';
  }
}

/**
 * Join `parts` onto the media root and refuse anything that escapes it.
 *
 * Two independent checks, deliberately redundant:
 *   1. Every part must be a safe name (no separators, no `..`, no NUL).
 *   2. The resolved absolute path must still be a descendant of the root.
 *
 * Either alone has known bypasses. Both together mean an escape requires a path
 * that contains no separator, no traversal, and still resolves outside a
 * directory — which is not a thing.
 */
export function resolveWithin(root: string, ...parts: string[]): string {
  for (const part of parts) {
    if (!isSafePathSegment(part)) {
      throw new MediaPathError(`Unsafe path component: ${JSON.stringify(part)}`);
    }
  }
  const absoluteRoot = resolve(root);
  const candidate = resolve(join(absoluteRoot, ...parts));
  const rel = relative(absoluteRoot, candidate);
  // `relative` returns '..'-prefixed for anything above the root, and an
  // absolute path when the two are on different roots (a Windows drive letter),
  // so both shapes have to be refused.
  if (rel === '' || rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new MediaPathError(`Path escapes the media root: ${JSON.stringify(parts.join('/'))}`);
  }
  return candidate;
}

export interface StoredFile {
  /** Path relative to the media root, which is what the database stores. */
  relativePath: string;
  absolutePath: string;
  bytes: number;
}

/** Write an uploaded source file into the media root. */
export async function storeUpload(
  config: MediaConfig,
  assetId: string,
  originalName: string,
  data: Buffer,
): Promise<StoredFile> {
  if (!isSafePathSegment(assetId)) {
    throw new MediaPathError('Unsafe asset id');
  }
  const dir = join(config.root, 'sources', assetId);
  await mkdir(dir, { recursive: true });

  // The uploaded name is never used as a path component. It only contributes an
  // extension, and even that is whitelisted: the stored name is derived, so a
  // hostile filename has nothing to attach itself to.
  const extension = safeExtension(originalName);
  const relativePath = join('sources', assetId, `source${extension}`);
  const absolutePath = join(config.root, relativePath);
  await writeFile(absolutePath, data);

  return { relativePath, absolutePath, bytes: data.byteLength };
}

const ALLOWED_EXTENSIONS = new Set(['.mp4', '.mov', '.mkv', '.webm', '.m4v', '.avi']);

/**
 * The extension to store the upload under.
 *
 * ffmpeg sniffs the container and ignores the extension, so this is not a
 * security control — the real check is that ffprobe has to succeed on the file
 * before anything else happens. It exists so the stored name is honest and so
 * an operator listing the directory can tell what is in it.
 */
export function safeExtension(originalName: string): string {
  const dot = originalName.lastIndexOf('.');
  if (dot < 0) return '.mp4';
  const extension = originalName.slice(dot).toLowerCase();
  return ALLOWED_EXTENSIONS.has(extension) ? extension : '.mp4';
}

export function isAllowedUploadName(originalName: string): boolean {
  const dot = originalName.lastIndexOf('.');
  return dot >= 0 && ALLOWED_EXTENSIONS.has(originalName.slice(dot).toLowerCase());
}

/** Open a file inside the media root for streaming. Throws if it escapes. */
export function openWithin(root: string, ...parts: string[]): Readable {
  return createReadStream(resolveWithin(root, ...parts));
}

export async function sizeWithin(root: string, ...parts: string[]): Promise<number> {
  const stats = await stat(resolveWithin(root, ...parts));
  return stats.size;
}

/**
 * Whether the media root exists and can be written to. Feeds /health, because a
 * stack whose media volume is read-only accepts uploads and loses them.
 */
export async function isWritable(root: string): Promise<boolean> {
  try {
    await mkdir(root, { recursive: true });
    await access(root, constants.W_OK);
    return true;
  } catch {
    return false;
  }
}
