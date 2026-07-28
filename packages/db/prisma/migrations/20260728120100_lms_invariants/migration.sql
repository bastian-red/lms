-- Invariants Prisma's schema language cannot express.
--
-- Each one exists because application code alone would let a specific bad state
-- reach the database. They are the last line of defence, not the first: the
-- services are supposed to make them unreachable, so a violation surfacing at
-- runtime means there is a bug to fix rather than a case to swallow.

-- ---------------------------------------------------------------------------
-- 1. One live transcode job per asset.
--
-- Two QUEUED jobs for the same asset means two workers transcode the same video
-- into the same directory at the same time, and the loser's segments are
-- interleaved with the winner's under one key. A partial unique index is the
-- right shape: it constrains only the non-terminal rows, so the history of DONE
-- and FAILED attempts is still kept.
CREATE UNIQUE INDEX "transcode_jobs_one_live_per_asset"
  ON "transcode_jobs" ("asset_id")
  WHERE "status" IN ('QUEUED', 'RUNNING');

-- ---------------------------------------------------------------------------
-- 2. A quiz attempt's score is a percentage.
--
-- Cheap, and it means a grading bug that produces 4200% or -1 is caught at the
-- write rather than discovered on an instructor's chart weeks later.
ALTER TABLE "quiz_attempts"
  ADD CONSTRAINT "quiz_attempts_score_percent_range"
  CHECK ("score_percent" >= 0 AND "score_percent" <= 100);

ALTER TABLE "quizzes"
  ADD CONSTRAINT "quizzes_passing_score_range"
  CHECK ("passing_score" >= 0 AND "passing_score" <= 100);

-- ---------------------------------------------------------------------------
-- 3. Watched seconds are non-negative and never exceed the media duration.
--
-- The duration lives on video_assets, one join away, so a CHECK cannot see it
-- and this has to be a trigger. It is the database-level statement of the whole
-- anti-cheat rule: whatever the API computes, a row claiming a student watched
-- 600 seconds of a 300-second lesson cannot be stored.
--
-- Deliberately permissive by a second: durations are floats from ffprobe and the
-- interval arithmetic rounds outward at the boundary, so an exactly-complete
-- lesson can land a few milliseconds over.
CREATE OR REPLACE FUNCTION lms_check_seconds_watched() RETURNS trigger AS $$
DECLARE
  media_duration double precision;
BEGIN
  IF NEW.seconds_watched < 0 THEN
    RAISE EXCEPTION 'seconds_watched must not be negative (got %)', NEW.seconds_watched
      USING ERRCODE = 'check_violation';
  END IF;

  SELECT va.duration_seconds INTO media_duration
  FROM video_assets va
  WHERE va.lesson_id = NEW.lesson_id;

  -- A quiz lesson has no asset, and a video still being transcoded has no
  -- duration yet. Neither is a violation; there is simply nothing to check.
  IF media_duration IS NULL OR media_duration <= 0 THEN
    RETURN NEW;
  END IF;

  IF NEW.seconds_watched > media_duration + 1 THEN
    RAISE EXCEPTION
      'seconds_watched (%) exceeds the % second duration of lesson %',
      NEW.seconds_watched, media_duration, NEW.lesson_id
      USING ERRCODE = 'check_violation';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER lesson_progress_seconds_watched_check
  BEFORE INSERT OR UPDATE ON "lesson_progress"
  FOR EACH ROW EXECUTE FUNCTION lms_check_seconds_watched();

-- ---------------------------------------------------------------------------
-- 4. A lesson's position is unique within its module, and a module's within its
-- course. Both already exist as Prisma @@unique constraints, but they are
-- non-deferrable, which makes reordering a list a problem: swapping positions 1
-- and 2 collides on the intermediate state no matter which row moves first.
--
-- Made deferrable so a reorder can happen as one transaction that is only
-- checked at COMMIT.
-- Prisma emits these as unique INDEXes, not table constraints, so they have to
-- be dropped as indexes; DROP CONSTRAINT silently does nothing and the ADD then
-- collides on the name.
DROP INDEX IF EXISTS "lessons_module_id_position_key";
ALTER TABLE "lessons"
  ADD CONSTRAINT "lessons_module_id_position_key"
  UNIQUE ("module_id", "position") DEFERRABLE INITIALLY IMMEDIATE;

DROP INDEX IF EXISTS "modules_course_id_position_key";
ALTER TABLE "modules"
  ADD CONSTRAINT "modules_course_id_position_key"
  UNIQUE ("course_id", "position") DEFERRABLE INITIALLY IMMEDIATE;

-- ---------------------------------------------------------------------------
-- 5. A READY video asset must actually have what playback needs.
--
-- The status field is what every access check keys on, so "READY with no output
-- directory and no key" is the state that produces a 500 in the player and a
-- lesson nobody can watch. Enforcing it here means the worker cannot mark an
-- asset ready before it has finished writing one.
ALTER TABLE "video_assets"
  ADD CONSTRAINT "video_assets_ready_is_complete"
  CHECK (
    "status" <> 'READY'
    OR (
      "output_dir" IS NOT NULL
      AND "encryption_key" IS NOT NULL
      AND "encryption_iv" IS NOT NULL
      AND "duration_seconds" > 0
    )
  );

-- The AES-128 key and IV are exactly 16 bytes. A shorter value would be padded
-- by the cipher and decrypt to noise, which presents as "the video is corrupt"
-- rather than as the configuration error it is.
ALTER TABLE "video_assets"
  ADD CONSTRAINT "video_assets_key_length"
  CHECK ("encryption_key" IS NULL OR octet_length("encryption_key") = 16);
ALTER TABLE "video_assets"
  ADD CONSTRAINT "video_assets_iv_length"
  CHECK ("encryption_iv" IS NULL OR octet_length("encryption_iv") = 16);

-- ---------------------------------------------------------------------------
-- 6. A certificate belongs to exactly one enrollment (already unique), and its
-- serial is unique (already unique). What is missing is that the enrollment it
-- belongs to must not be revoked. Enforced in the service rather than here,
-- because revoking access after the fact must not delete a certificate that was
-- legitimately earned — the serial stays valid, which is the honest behaviour.

-- ---------------------------------------------------------------------------
-- 7. The claim query's covering index.
--
-- `SELECT ... WHERE status = 'QUEUED' AND available_at <= now() ORDER BY
-- available_at FOR UPDATE SKIP LOCKED` is the hottest query the worker runs. The
-- composite index from the schema covers the predicate; this partial one keeps
-- it small by excluding the DONE rows, which are the ones that accumulate.
CREATE INDEX "transcode_jobs_claimable"
  ON "transcode_jobs" ("available_at")
  WHERE "status" = 'QUEUED';
