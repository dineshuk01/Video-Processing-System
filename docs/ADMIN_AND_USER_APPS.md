# Admin app and User app

The project ships two separate front-end applications on one backend.

| | **User app** | **Admin app** |
|---|---|---|
| Audience | Public viewers | You and your team |
| URL (`APP_MODE=all`) | `/` | `/admin/` |
| Source | `web/user/` | `web/admin/` |
| API | `/api/public/*` (read-only) | `/api/admin/*` (needs sign-in) |
| Can see | Published videos only: title, poster, duration, quality | Everything: drafts, jobs, queue, logs, failures, system health |
| Can do | Browse, search, play HLS, My List, watch history | Upload, publish/unpublish, edit title and qualities, retry/reprocess, delete, monitor |

`web/shared/common.js` holds a few UI helpers (escaping, toasts, dialogs) used by both.

## Running

```bash
npm run dev          # API + both apps, APP_MODE=all
npm run dev:worker   # the queue worker (runs FFmpeg)
```

- User site: http://localhost:5000/
- Admin dashboard: http://localhost:5000/admin/

### Run them as separate servers (own port each)

One command starts the user site, the admin dashboard and the queue worker as three separate processes:

```bash
npm run dev:split     # development: TypeScript, restarts on changes
npm run build && npm run start:split   # compiled
```

- User site: http://localhost:5000/ (`USER_PORT`)
- Admin dashboard: http://localhost:5001/admin/ (`ADMIN_PORT`)

The two servers share the same data (the same `LOCAL_DATA_DIR` locally, or the same buckets and tables on AWS), so what the admin does shows up on the user site: renames, publishing and unpublishing, thumbnails and series. The admin's **View public site** link goes to `USER_APP_URL` (set automatically by `dev:split`; set it yourself when deploying, e.g. `https://watch.example.com/`). Changes to publishing reach the user server within about 5 seconds, for media that is already open.

You can also start each one yourself: `APP_MODE=user USER_PORT=5000 npm start` and `APP_MODE=admin ADMIN_PORT=5001 USER_APP_URL=... npm start`, plus `npm run dev:worker` for encoding. Without `APP_MODE` (the default `all`) a single server on `PORT` serves both, as before.

A `user` server has no admin routes at all (`/admin`, `/api/admin`, `/metrics` and `/api/docs` are 404, and uploads are refused even with a valid key). An `admin` server has no public API, so it can be firewalled or kept on a private network. `docker compose up` starts them as separate services (user on 5000, admin on 5001).

## Audio languages and subtitles

**Several audio languages in one file** (common with files from Telegram, e.g. Hindi + English): processing finds every audio track, encodes each one on its own, and the player gets an **Audio** menu. The video sizes carry no sound; the languages are separate streams the player switches between (a master playlist with `EXT-X-MEDIA` entries). A track is named from the file's own title, else its language ("Hindi"); an admin can rename it in **Edit settings**. A file with a single audio track works as before.

**Subtitles** come from two places and appear together in the player's **Subtitles** menu (off until chosen; the choice is remembered by language):

- *In the file*: text subtitle streams (SRT, ASS, mov_text, WebVTT) are converted to WebVTT during processing. Picture-based ones (Blu-ray PGS, DVD) cannot be converted; the log says how many were skipped.
- *Uploaded by an admin*: in **Edit settings**, choose a language, optionally a name, and add an `.srt` or `.vtt` file (up to 2 MB, UTF-8 or UTF-16). SRT is converted to WebVTT. It works at once with no reprocessing, and uploaded subtitles are kept when the video is reprocessed (subtitles found in the file are rebuilt).

Videos processed before this feature need **Reprocess** to pick up extra audio languages or embedded subtitles; uploaded subtitles can be added to any video straight away.

API (admin): `POST /api/admin/videos/:id/subtitles?lang=hi&label=Hindi` (file as the body), `DELETE /api/admin/videos/:id/subtitles/:trackId`, `PATCH /api/admin/videos/:id/tracks/:trackId` with `{ "label": "..." }`.

## Sections: Movies, Series, Anime

The public site has three sections. A standalone video is a **Movie**; a series is under **Series**. Either can be filed under **Anime** instead: set **Section** to Anime in the series form, or in a video's **Edit settings** (episodes follow their series). Anime titles then appear on the Anime page and the home page's Anime row, and no longer under Movies or Series. API: `category: "anime"` (or `""` to move it back) on `PATCH /api/admin/series/:id` and `PATCH /api/admin/videos/:id`.

### Season numbers

A new series starts with Season 1; the **New series** form has a **First season number** if you are starting with a later season (0 is for specials). On the series page each season has **Change number**, which renumbers the season and moves all of its episodes with it (refused if that number is already a season of the series). API: `firstSeason` on `POST /api/admin/series`, and `PATCH /api/admin/series/:id/seasons/:number` with `{ "number": 2 }`.

## Viewer accounts

The user site needs an account: visitors see a sign-in page and can create an account with their name, email and password. Nothing (the catalogue, the video files) is available without signing in; set `REQUIRE_LOGIN=false` only for a private test setup.

- **Each person has their own session**: a signed, HttpOnly cookie valid for 30 days (`USER_SESSION_SECRET` signs it). Signing out ends it.
- **Saved per account**: name, email, password (stored as a salted scrypt hash, never in plain text), My List, and how far each video was watched, which also drives Continue Watching and the watch history. They follow the viewer to any device. Playback speed and the chosen subtitle/audio language stay on the device.
- **Storage**: `users.json` locally; on AWS a DynamoDB table of its own (`USERS_TABLE_NAME`), keyed by `USER#<email>` with one item for the profile, one for My List and one per watched video.
- **Protection**: wrong email and wrong password give the same answer; sign-up and sign-in are limited to 20 attempts per 15 minutes per address.
- On AWS the video files themselves are served by CloudFront and are not yet tied to the session: the catalogue and stream addresses need a login, but a stream address that is passed on keeps working. Signed CloudFront cookies would close this; they need the site on its own domain.

**Sign in with Google.** With `GOOGLE_CLIENT_ID` set, the sign-in page shows only "Continue with Google", and email/password sign-up and sign-in are refused (set `ALLOW_PASSWORD_LOGIN=true` to keep both). Google proves the person owns the address, so made-up emails cannot get in. The server checks Google's signature on the ID token, that it was issued for this client ID, has not expired, and that Google verified the email. The account is keyed by that email, so a viewer who signed up with a password earlier lands in the same account. `GET /api/auth/config` tells the page which methods are on.

API: `POST /api/auth/signup` `{ name, email, password }`, `POST /api/auth/google` `{ credential }`, `POST /api/auth/login`, `POST /api/auth/logout`, `GET /api/auth/me`; `GET /api/me`, `PUT /api/me/list` `{ items }`, `PUT /api/me/progress/:videoId` `{ pos, seen, watched }`, `DELETE /api/me/progress[/:videoId]`.

## Admin sign-in

Set `ADMIN_API_KEY` (see `.env.example`). The admin app asks for it and keeps a signed, HttpOnly session cookie. Scripts can send it as an `x-admin-key` header.

| `ADMIN_API_KEY` | `NODE_ENV` | Result |
|---|---|---|
| set | any | Sign-in required |
| not set | development | Admin is open (a warning is logged) |
| not set, or `change-me` | production | Admin is disabled (503) |

The key is a stand-in for your real login system. Everything depends on one function, `isAdminRequest` in `src/middleware/adminAuth.ts`; replace it when you build login.

## Publishing

Finished videos start as **drafts**. The public site only shows videos that are both **completed** and **published**. Publish from the admin *Videos* page (or the preview page), or tick *Publish automatically when ready* on upload. Unpublishing hides the video and its media straight away.

Media is guarded too: in local mode `/api/local-s3` serves a video's HLS files to the public only while it is published, and raw uploads only to admins.

## Quality and reprocessing

Choose renditions (360p/480p/720p/1080p) on upload, or edit them later and use *Save & reprocess*. Renditions larger than the source are skipped, and if none of the chosen ones fit, the smallest chosen (or 360p) is generated so the video still plays.

Failed jobs retry automatically up to 3 times (after 15 s, then 45 s, using a queue delay, so a worker restart can't lose a retry). After that the video is `FAILED`; use *Retry* on the Jobs page. Every step is written to the video's processing log (Jobs → Log, or the global Logs page).

## How videos are encoded

All renditions are produced by a single FFmpeg run, so the source is decoded once instead of once per rendition. Encoding uses constant-quality x264 (CRF 17, change with `FFMPEG_CRF`; each size has a peak bitrate cap of 1.2 / 2.5 / 6 / 12 Mbps for 360p / 480p / 720p / 1080p) with the `veryfast` preset (change it with `FFMPEG_PRESET`) and always outputs 8-bit video: browsers cannot play the 10-bit H.264 ("High 10") that 10-bit sources would otherwise produce. A size such as "720p" is a class: a video qualifies when it is at least that **wide or tall**, so a 1280×536 widescreen film gets a native 720p. Each rendition fits its 16:9 box while keeping the source's aspect ratio. Sizes the source doesn't reach are skipped (and the log says so) unless **Also create sizes larger than the source** is ticked, which upscales them: no extra detail, slower, more storage. The admin pages list the renditions that were actually made. Audio is mixed down to stereo. The progress bar follows FFmpeg's real position in the video. Encoding time depends on the video's *duration* and your CPU, not its file size: a 3-hour movie takes hours on a laptop CPU.

## Stopping, pausing and deleting

Every video row in the admin *Videos* and *Processing Jobs* pages has **Pause** (queued or processing videos) and **Delete** buttons, and the row menu has the rest.

- **Pause** stops the job now (FFmpeg is killed within a couple of seconds, longer if the machine is busy) and holds the video as **Paused**. The original upload is kept, partial output is removed, and the worker is free for the next video. **Resume** starts processing again from the beginning. It is not a freeze-and-continue: FFmpeg cannot be suspended the same way on Windows and Linux.
- **Delete** works at any stage. On a queued or processing video it stops the job first ("Stop & delete"), then removes the original and every processed file. A stopped job is not counted as a failure and is not retried.
- **Delete processed files** removes only the streaming output of a finished, failed or paused video. The video leaves the public site and becomes *Paused* with its original kept, so you can process it again with **Resume**. It is refused if the original upload is gone (use Delete instead).

## Thumbnails

Each video gets an automatic thumbnail (a frame from 2 seconds in). An admin can change it three ways:

- **Upload an image** — *Videos → ⋯ → Edit settings → Thumbnail → Upload image*. JPEG, PNG or WebP up to 8 MB. Whatever the format, it is stored as a JPEG no wider than 1280 px. The file's real type is checked, not just its name.
- **Use a frame from the video** — open the video's preview, pause on the frame you want and press **Use this frame as thumbnail**. The server reads that frame from the original upload, so it is full quality.
- **Use the automatic one** — resets a custom thumbnail.

A custom thumbnail is kept separately from the automatic one, so it survives reprocessing and "Delete processed files". It is removed when the video is deleted. The same Upload / reset options exist for a **series poster** (*Series → Edit details*); without one, a series uses its first episode's thumbnail. Visibility follows the video: a custom thumbnail is public only while its video (or series) is.

## Series, seasons and episodes

Admin → **Series**. Create a series (title and description), and it starts with *Season 1*. Add more seasons with **Add a season** (0 is for specials). Episodes are ordinary videos with a series, season and episode number, so everything else (processing, qualities, rename, pause, retry) works the same.

- **Upload episodes** on a season opens the Upload page with that series and season already chosen. Files are numbered in list order from the first free episode number, so uploading eight files gives episodes 1 to 8. Rename them afterwards from the series page.
- **Add existing video** attaches a video you already uploaded. **Edit** changes an episode's series, season, number and title; two episodes can't share a slot (you get an error naming the clash).
- **Remove from series** turns an episode back into a standalone video and sets it to draft, so it can't show up as a movie by accident.
- **Publishing needs both levels.** Viewers see an episode only when the *episode* is published (and finished) **and** its *series* is published. New series are hidden. Unpublishing the series hides every episode at once, including their video files.
- **Deleting a series** asks whether to keep the episode videos (as drafts) or delete them too.

On the user site, series show as tiles in a *TV Series* row and on the *Series* page. A series page has the description, a **Play / Resume** button (it resumes an unfinished episode, offers the next one after a finished episode, or starts at S1 E1), a season picker and the episode list with progress and watched ticks. Episodes play with *Next episode* / *Previous*, autoplay into the next episode (across seasons), and a list of the season on the watch page. Series work with My List, search (by series or episode title), history and Continue Watching.

Series are stored in `series.json` next to `db.json` in local mode. A DynamoDB version for AWS mode still needs to be written along with the other AWS data services.

## What stays on the viewer's device

My List and watch history are stored in the viewer's browser (`localStorage`), because there are no user accounts yet. When you add login, move them to the server keyed by user id.

## Known limits

- **AWS media access:** publishing hides a video from the public API, but S3/CloudFront objects can still be fetched by anyone who knows the URL. For strict privacy on AWS use signed URLs/cookies.
- **Database:** this branch uses the JSON-file database (now with cross-process locking). The DynamoDB branch needs the same two additions: `appendEvent` and `listAll`.
- **Admin sessions** are signed tokens with no server-side store, so they can't be revoked individually; rotating `ADMIN_API_KEY` signs everyone out.
- **Captions:** the old placeholder sample captions are off by default (`ENABLE_PLACEHOLDER_CAPTIONS=true` brings them back).
