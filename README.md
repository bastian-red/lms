# LMS — adaptive video streaming with access control that actually holds

[![CI](https://github.com/bastian-red/project003--lms/actions/workflows/ci.yml/badge.svg)](https://github.com/bastian-red/project003--lms/actions/workflows/ci.yml)

An online learning platform: courses, HLS video lessons, quizzes, PDF certificates
and an instructor dashboard.

The interesting part is not the CRUD. It is that **the video is genuinely
unplayable by anyone who is not currently enrolled**, and that **progress cannot
be faked by dragging the scrubber**. Both are mechanisms, not settings, and each
one has a test that fails if you remove it.

![Demo](assets/demo.gif)

---

## The five properties, and the test that proves each

| # | Property | Where it lives | What proves it |
|---|---|---|---|
| 1 | Every segment on disk is AES-128 encrypted | `services/media/src/transcode.ts` | reads byte 0 of a real `.ts` and asserts it is **not** `0x47`, then decrypts it with the served key and gets a decodable stream |
| 2 | Authorization is live, not a one-time gate | `apps/api/src/media/media-access.service.ts` | revokes an enrollment mid-playback; the very next key fetch is 403 with the ticket still valid |
| 3 | Progress cannot be faked by seeking | `packages/shared/src/progress/intervals.ts` | seeks to `duration - 2`, reports it, and the lesson credits ~2 seconds and stays incomplete |
| 4 | Answer keys never leave the server | `packages/shared/src/quiz/grading.ts` | deep-scans the DTO and the rendered HTML for `isCorrect` / `acceptedAnswers` |
| 5 | A certificate means the course was finished | `apps/api/src/certificates/certificates.service.ts` | 409 with the outstanding lessons named; ten concurrent requests produce exactly one serial |

---

## How the video pipeline works

```
upload ──▶ VideoAsset + TranscodeJob        one transaction, so an asset that
           (apps/api/src/instructor)        nothing will process is unreachable
             │
             ▼
        apps/worker  ── SELECT … FOR UPDATE SKIP LOCKED
             │
             ▼
      services/media ── ffmpeg × 3 rungs, AES-128 via -hls_key_info_file
             │              key written to a private temp dir, removed in finally
             ▼
   var/media/assets/<id>/{360p,540p,720p}/seg*.ts   ← ciphertext, and nothing else
```

**The ladder.** Rungs above the source height are skipped, because upscaling
spends CPU and bandwidth to deliver a blurrier picture than the source.

| Rung | Resolution | Video | Audio |
|---|---|---|---|
| 360p | 640×360 | 800 kbps | 96 kbps AAC |
| 540p | 960×540 | 1400 kbps | 128 kbps AAC |
| 720p | 1280×720 | 2800 kbps | 128 kbps AAC |

Keyframes are forced onto segment boundaries and the GOP length is derived from
the probed frame rate, so boundaries line up across rungs. Without that, a
player switching rendition mid-stream stutters or skips.

**Encryption.** A 16-byte key and IV per asset. The key is handed to ffmpeg
through a key-info file in a private temp directory, deleted in a `finally`, and
persisted on the asset row. The URI written into the playlist is a placeholder
that the API rewrites per request, so the media directory holds nothing that can
decrypt itself. `assertEncrypted` reads a produced segment and refuses to report
success if it looks like a transport stream — a silent fallback to plaintext
would otherwise ship an unprotected course looking exactly like a protected one.

**Verification the transcode was complete.** ffmpeg exits 0 on a source it could
only partially read, so the sum of the `#EXTINF` values is cross-checked against
the probed duration. A truncated transcode is caught rather than stored.

### Playback, and why there are four routes

Nothing under `MEDIA_ROOT` is statically served.

| Route | Auth | Why |
|---|---|---|
| `GET /lessons/:id/manifest.m3u8` | service token | full enrollment check; mints the ticket |
| `GET /lessons/:id/rendition/:rung/:file` | ticket | rewrites segment + key URIs |
| `GET /lessons/:id/segment/:rung/:file` | ticket | ciphertext, useless without the key |
| `GET /lessons/:id/key` | ticket **+ live enrollment re-read** | where revocation bites |

The credential travels in the URL because `hls.js` and Safari's native player
issue their own requests for playlists, segments and the key, and there is no
portable way to attach an `Authorization` header to all of them. So the ticket
is designed to be safe there: HMAC-SHA256 over `{sub, lid, exp}`, compared with
`timingSafeEqual`, bound to one user **and** one lesson, and worth nothing on
its own — it only ever opens encrypted bytes.

The key endpoint is the one that re-reads the database. That is the whole
difference between "access was checked once" and "access is checked": revoking a
student stops their playback within one segment, while the ticket in their
browser is still minutes from expiry.

### Why the queue is Postgres and not Redis

`SELECT … FOR UPDATE SKIP LOCKED`. The job row and the asset row it describes
move in one transaction, so "asset exists, nothing will ever process it" is not
a reachable state. With an external broker, a crash between the two produces
exactly that and nothing in the system knows. A lease (`lockedAt` +
`JOB_LEASE_SECONDS`) makes `kill -9` on a worker recoverable rather than
permanent.

### Why progress is interval coverage

A lesson completes at 90% of **distinct seconds covered**, computed from merged
half-open intervals. Three defences, all in `packages/shared`:

1. every reported interval is clamped into `[0, duration]`;
2. new coverage per beat is capped at the wall-clock elapsed since that
   student's previous beat, so "POST one interval of `[0, 600]`" buys nothing;
3. coverage is a union, so replaying a range adds zero.

A Postgres trigger refuses any row claiming more watched seconds than the media
has — the last line of defence, and a violation there means the engine has a bug.

---

## Run it

```bash
git clone https://github.com/bastian-red/project003--lms.git
cd project003--lms

docker compose -f infra/docker-compose.yml up -d      # postgres 5435, redis 6382, mailhog 1028
cp .env.example .env
openssl rand -base64 32                                # paste into AUTH_SECRET

pnpm install
pnpm db:generate && pnpm db:migrate
pnpm db:seed        # generates demo video with ffmpeg, then transcodes it for real
pnpm dev            # web :3000, api :4000, worker
```

**ffmpeg is required.** `sudo apt install ffmpeg` / `brew install ffmpeg`, or
point `FFMPEG_PATH` and `FFPROBE_PATH` at an existing build. The seed synthesises
its own source clips with `testsrc2` and `sine`, so no video file is ever
committed to the repo.

Sign in as:

| Account | Role |
|---|---|
| `ada@lms.local` | student, enrolled |
| `grace@lms.local` | instructor |
| `admin@lms.local` | admin |

Password for all three: `course-demo-password`.

### Health

`GET /health` checks Postgres, Redis, that ffmpeg resolves and runs, that the
media directory is writable, and that a worker has checked in recently. Any
failure returns 503. The last three matter: a stack with no ffmpeg or no worker
accepts uploads and silently never produces a lesson.

---

## Tests

```bash
pnpm lint && pnpm typecheck && pnpm test    # gate: 356 unit tests, no DB, no network, <5s
node scripts/env-contract.mjs               # gate: turbo.json vs .env.example vs what the code reads
./scripts/dev-smoke.sh                      # boots `pnpm dev` and asserts the course page renders
./scripts/integration.sh                    # 43 tests against real Postgres + Redis + ffmpeg
./scripts/e2e.sh                            # 58 Playwright tests × chromium + firefox
./scripts/a11y-baseline.sh                  # record an accessibility baseline to /tmp
```

The integration lane seeds as part of the run, which means it transcodes real
video with real ffmpeg every time. That is deliberate: the media fixtures the
tests read are produced by the same code path an instructor's upload takes.

**Environment contract (`scripts/env-contract.mjs`).** Turborepo 2 runs tasks in
strict environment mode: a task's child process sees only the names declared in
`turbo.json`, and everything else is stripped without a warning. This repo
shipped with eight names declared and thirty-three read, so the documented
`pnpm dev` started an API with no `AUTH_SECRET` — it died at boot, and every
server render then failed with `ECONNREFUSED` against a dead `:4000` — plus a
transcode worker with no `WORKER_ID` or lease settings. The check asserts
everything the source reads is declared, everything `.env.example` documents is
declared, every declared name is used, and every documented name is actually
read. It found `TRANSCODE_MAX_ATTEMPTS` and `TRANSCODE_BACKOFF_SECONDS` being
read by the worker while documented nowhere; both are in `.env.example` now.

**Dev smoke (`scripts/dev-smoke.sh`).** The contract check proves the names are
declared; it cannot prove they arrive. This boots the real `pnpm dev` and asserts
`/health` reports Postgres, Redis, media storage and the worker green, then that
`/courses/adaptive-video-streaming` renders the seeded course title — a
status-code check alone would pass on a 200 error page. It launches with every
name in `.env` stripped from the environment, so the app can only be configured
by the repo, the way a fresh clone is. `ffmpeg` is reported but not required:
everything except transcoding works without it.

### See it for yourself

```bash
# 1. anonymous manifest fetch → 401
curl -si localhost:4000/lessons/$LESSON/manifest.m3u8 | head -1

# 2. a segment on disk is not a transport stream (first byte is not 0x47)
od -A d -t x1 -N 4 var/media/assets/$ASSET/720p/seg00000.ts

# 3. ffmpeg cannot decode it without the key
ffmpeg -i var/media/assets/$ASSET/720p/seg00000.ts -f null -   # Invalid data found
```

---

## Two design languages, one token layer

The product has two audiences whose needs point in opposite directions. A
student reads for a sustained stretch and is trying to finish something. An
instructor scans dense state and is trying to compare rows. Serving both with
one visual language means serving one of them badly, so `apps/web/app` splits
into two route groups, each with its own scope:

| | `(learn)` — student | `(console)` — instructor, admin |
|---|---|---|
| Canvas | warm paper `#fbf8f3` / `#14120f` | cool slate `#f8fafc` / `#0b1220` |
| Accent | teal — it means *progress* | blue — it means *control* |
| Type | Source Serif 4 for prose and headings | IBM Plex Sans throughout, no serif |
| Figures | JetBrains Mono, tabular | JetBrains Mono, tabular |
| Body | 17px, sentence case, ≤68ch measure | 15px, uppercase mono metadata |
| Geometry | 8px radius, real gaps | 2px radius, 1px hairline seams |
| State | semantic colour + glyph + word | same contract, denser |

Two accents that never meet is cheaper than one accent that has to mean two
things: a student never sees the blue and an instructor never sees the teal. The
colour temperature is doing real work — it is how someone knows which surface
they are on before reading a word.

Route groups do not appear in the URL, so the split cost nothing in routing.
They share `globals.css`: one spacing scale, one type scale, one focus ring, one
motion timing, one accessibility contract — which is what stops it reading as
two apps bolted together.

**Why it changed again.** The two scopes were right; what they wore was not.
Both surfaces were dressed in the same monochrome, uppercase, `#ff0000`-accented
language — the same one two sibling repos in this portfolio were also wearing, to
the byte. It told a reader nothing about *this* product, and it left the Learn
scope shouting "COVERAGE" and "RENDITION" at a student in the middle of a lesson,
which its own file header had already argued against.

Beyond the palette, three structural changes:

- **Theatre mode.** The lesson page dims its surround to `--surface-2` and lifts
  the video frame on a soft shadow, so for the twenty minutes someone is watching
  the frame is the brightest thing on screen. Nothing to switch on and no state to
  remember, which is the point.
- **Progress rings.** On a list of enrolled courses the question is "which am I
  nearly done with", and a horizontal bar answers that only after its label has
  been read. `components/progress-ring.tsx` is a conic-gradient on one element —
  no SVG, no charting library — with the percentage inside it as text.
- **The retention charts got rebuilt** against the `dataviz` procedure: one
  series so no legend, the accent for the curve and a reserved status colour for
  the drop marker, a pinned 0–100 axis so two lessons stay comparable, and a
  `<details>` table under every curve carrying the same numbers.

**What the earlier pass fixed.** The language before that was inherited from an
e-commerce template and was actively hurting the learning surfaces. `.choice` is a `<label>`, so
quiz answers inherited the global label rule and rendered in dim uppercase mono;
the global `input { width: 100% }` stretched each radio across its row and shoved
the answer text to the far right. `--ok` resolved to plain white in dark mode, so
"you answered correctly" was drawn in the same colour as ordinary chrome. And a
`content: '// SHOP'` pseudo-element rendered literally above the catalogue
heading. All four are now regression-tested rather than remembered.

**Colour is never the only channel.** Every state carries a glyph and a word as
well. Pass and fail are also held apart in *luminance*, not just hue — red and
green at the same tone collapse to one grey for the most common colour-vision
deficiency, which on a quiz means both answers look identical.

### Measured, not asserted

"It looks better" is not a result, so three things are numbers:

| Outcome | Before | After | Enforced by |
|---|---|---|---|
| axe-core violations, 15 routes × 2 schemes | **56 nodes**, 3 rules | **0** | `e2e/tests/a11y.spec.ts` |
| Token pairs below WCAG AA | 22 contrast failures from one token | **0** | `apps/web/lib/contrast.test.ts` |
| `var(--x)` references resolving to nothing | 2 (silent black charts) | **0** | `apps/web/lib/tokens.test.ts` |
| The two surfaces still looking alike | — | measured | `apps/web/lib/identity.test.ts` |

The contrast gate parses the real stylesheets rather than a copy of the palette,
so it cannot pass against values the browser is not using. It was written before
the new colours were chosen, and the colours were then tuned until it passed —
contrast is arithmetic, and arithmetic does not belong in anyone's eye.

The identity gate is newer and answers a different question. This repo is one of
a portfolio, and the portfolio's failure mode is that every project ends up
wearing whatever language the last one wore. So `identity.test.ts` pins both
palettes, all three typefaces and the two radii, and measures the claim the split
rests on: that Learn's canvas is warm (red channel above blue) and the console's
is not, in both schemes, and that the two accents are different colours. It also
fails on any reappearance of `#ff0000`, the accent all three sibling repos once
shared.

The token gate exists because of a bug this redesign shipped and then caught:
renaming `--panel-2` to `--surface-2` left `retention-charts.tsx` passing
`fill="var(--panel-2)"` into Recharts. An undefined custom property in an SVG
fill does not warn, does not throw and does not fail a type check — it falls back
to black. The charts rendered as solid dark slabs and all 116 tests still passed.

## Architecture

```
project003--lms/
├── apps/web/                 Next.js 14 App Router — student, instructor, admin
│   └── app/(learn)|(console) two design scopes, same URLs
├── apps/api/                 NestJS — every DB write, all media authorization
├── apps/worker/              transcode worker (SKIP LOCKED poller)
├── services/media/           ffmpeg ladder, HLS packaging, AES key custody, storage
├── services/certificates/    pdfkit rendering + serial generation
├── services/notifications/   nodemailer → Mailhog locally
├── packages/shared/          zod contracts + the pure engines
├── packages/db/              Prisma schema, migrations, seed
├── e2e/                      Playwright
└── infra/                    docker-compose + 3 Dockerfiles
```

**Stack:** Next.js 14, NestJS 10, PostgreSQL 16 + Prisma, Redis (rate limiting
only), ffmpeg, hls.js, Recharts, pdfkit, Auth.js v5.

**Auth.** The web app owns the Auth.js session; the API holds no session state.
The web server mints a five-minute HS256 service token from the shared
`AUTH_SECRET`, and that is the only thing that crosses between them — so the API
has no session store, no cookie parsing and no CSRF surface.

**Backend is CommonJS.** NestJS resolves constructor dependencies from the type
metadata `emitDecoratorMetadata` writes at compile time, and an `import type`
erases the class the metadata needs. `consistent-type-imports` is therefore off
for `apps/api`; its autofix produces code that compiles cleanly and dies at boot.

### Database invariants

Declared in `packages/db/prisma/migrations/*_lms_invariants`, because the
application is supposed to make them unreachable and a violation means there is
a bug to fix rather than a case to swallow:

- one non-terminal `TranscodeJob` per asset (partial unique index);
- a `READY` asset must have an output directory, a key, an IV and a duration;
- key and IV are exactly 16 bytes;
- `LessonProgress.secondsWatched` never exceeds the media duration (trigger);
- quiz scores stay within 0–100.

---

## Ports

Chosen so this stack coexists with the other projects in the portfolio.

| Service | Port |
|---|---|
| Postgres | 5435 |
| Redis | 6382 |
| Mailhog | 1028 (SMTP), 8028 (UI) |
| API | 4000 |
| Web | 3000 |

---

## Not deployed

This repository is published to GitHub and hosted nowhere. `docker compose up`
plus `pnpm dev` gives a working stack in one command, CI builds all three images
on every push, and the health check is exercised by the test suite. A repo that
clones and runs is the signal; a URL was never the point.
