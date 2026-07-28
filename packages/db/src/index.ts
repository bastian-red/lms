import { PrismaClient } from '../generated/client';

export * from '../generated/client';
export { PrismaClient };

/**
 * Error codes the services branch on.
 *
 * There are two vocabularies here and confusing them is a silent failure, not a
 * loud one. Prisma's typed client reports its **own** codes (`P2002` for a
 * unique violation); only `$queryRaw` surfaces the underlying Postgres
 * **SQLSTATE** (`23505`). A guard that checks the SQLSTATE alone type-checks,
 * compiles, and never fires against an ordinary `create()` — which for the
 * certificate race means two certificates for one enrollment, discovered only
 * under concurrency.
 *
 * So every predicate below accepts both.
 */
export const PRISMA_UNIQUE_VIOLATION = 'P2002';
export const PRISMA_CONSTRAINT_VIOLATION = 'P2004';
export const PG_CHECK_VIOLATION = '23514';
export const PG_UNIQUE_VIOLATION = '23505';
export const PG_FOREIGN_KEY_VIOLATION = '23503';
/** RAISE EXCEPTION from a plpgsql trigger without an explicit ERRCODE. */
export const PG_RAISE_EXCEPTION = 'P0001';

/**
 * Names of the invariants declared in the _lms_invariants migration.
 *
 * Code that catches a constraint violation matches on these rather than on the
 * message text: Postgres error messages are localised and reworded between
 * versions, and a service that greps them breaks on an upgrade.
 */
export const ONE_LIVE_JOB_INDEX = 'transcode_jobs_one_live_per_asset';
export const CERTIFICATE_ENROLLMENT_UNIQUE = 'certificates_enrollment_id_key';
export const CERTIFICATE_SERIAL_UNIQUE = 'certificates_serial_key';
export const ENROLLMENT_UNIQUE = 'enrollments_user_id_course_id_key';
export const READY_ASSET_COMPLETE = 'video_assets_ready_is_complete';
export const SECONDS_WATCHED_TRIGGER = 'seconds_watched';

interface PgError {
  code?: string;
  message?: string;
  meta?: { constraint?: unknown; target?: unknown; message?: unknown };
}

function pgError(err: unknown): PgError | null {
  return typeof err === 'object' && err !== null ? (err as PgError) : null;
}

function constraintName(err: PgError): string {
  const constraint = err.meta?.constraint;
  if (typeof constraint === 'string') return constraint;
  const target = err.meta?.target;
  if (typeof target === 'string') return target;
  if (Array.isArray(target)) return target.join(',');
  return '';
}

export function isUniqueViolation(err: unknown, constraint?: string): boolean {
  const e = pgError(err);
  if (!e || (e.code !== PRISMA_UNIQUE_VIOLATION && e.code !== PG_UNIQUE_VIOLATION)) return false;
  return constraint === undefined || constraintName(e).includes(constraint);
}

export function isCheckViolation(err: unknown, constraint?: string): boolean {
  const e = pgError(err);
  if (!e || (e.code !== PG_CHECK_VIOLATION && e.code !== PRISMA_CONSTRAINT_VIOLATION)) {
    return false;
  }
  return constraint === undefined || constraintName(e).includes(constraint);
}

/**
 * True when a second live transcode job was queued for an asset that already
 * has one. Callers treat it as "already queued" and return the existing job
 * rather than as an error, which is what makes re-uploading idempotent.
 */
export function isDuplicateLiveJob(err: unknown): boolean {
  // Matched on the index name because this constraint is declared in raw SQL
  // (a partial unique index Prisma's schema cannot express), so that is what
  // Postgres reports and what Prisma passes through.
  return isUniqueViolation(err, ONE_LIVE_JOB_INDEX);
}

/**
 * True when a second certificate was requested for an enrollment that already
 * has one. This is the race the idempotency of `POST /certificates` rests on:
 * the loser catches this and reads back the winner's row.
 *
 * The match is on the *column or field* name, not on the index name. Prisma
 * reports `meta.target` as the model field (`enrollmentId`) or the mapped
 * column (`enrollment_id`) depending on version and driver, and never as the
 * Postgres index name (`certificates_enrollment_id_key`). Matching the index
 * name compiles, type-checks, and silently never fires — which under
 * concurrency means two certificates for one enrollment.
 */
export function isDuplicateCertificate(err: unknown): boolean {
  if (!isUniqueViolation(err)) return false;
  const name = constraintName(pgError(err)!).toLowerCase();
  return name.includes('enrollment_id') || name.includes('enrollmentid');
}

/**
 * True when the lesson_progress trigger refused a row claiming more watched
 * seconds than the media has. Seeing this means the interval engine let
 * something through that it should have clamped, so it is logged loudly rather
 * than swallowed.
 */
export function isSecondsWatchedViolation(err: unknown): boolean {
  const e = pgError(err);
  if (!e) return false;
  if (e.code !== PG_RAISE_EXCEPTION && e.code !== PG_CHECK_VIOLATION) return false;
  const text = `${e.message ?? ''} ${String(e.meta?.message ?? '')}`;
  return text.includes(SECONDS_WATCHED_TRIGGER);
}

let client: PrismaClient | undefined;

/**
 * Memoized singleton.
 *
 * Next.js hot-reload re-evaluates modules on every edit and the worker imports
 * this from several files; without the memo each one opens its own pool and a
 * few minutes of development exhausts Postgres's connection limit.
 */
export function getPrisma(): PrismaClient {
  if (!client) client = new PrismaClient();
  return client;
}
