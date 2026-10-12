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

### Run them as two servers

Set `APP_MODE` to serve only one app, so each can be deployed (and firewalled) separately:

```bash
APP_MODE=user  PORT=5000 npm start    # public site only
APP_MODE=admin PORT=5001 npm start    # admin only
```

A `user` server has no admin routes at all (`/admin`, `/api/admin`, `/metrics` and `/api/docs` are 404, and uploads are refused even with a valid key). An `admin` server has no public API. Both share the same data (the same `LOCAL_DATA_DIR` locally, or the same buckets/tables on AWS). `docker compose up` starts them as separate services (user on 5000, admin on 5001).

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

All renditions are produced by a single FFmpeg run, so the source is decoded once instead of once per rendition. Encoding uses the `veryfast` x264 preset (change it with `FFMPEG_PRESET`) and always outputs 8-bit video: browsers cannot play the 10-bit H.264 ("High 10") that 10-bit sources would otherwise produce. A size such as "720p" is a class: a video qualifies when it is at least that **wide or tall**, so a 1280×536 widescreen film gets a native 720p. Each rendition fits its 16:9 box while keeping the source's aspect ratio. Sizes the source doesn't reach are skipped (and the log says so) unless **Also create sizes larger than the source** is ticked, which upscales them: no extra detail, slower, more storage. The admin pages list the renditions that were actually made. Audio is mixed down to stereo. The progress bar follows FFmpeg's real position in the video. Encoding time depends on the video's *duration* and your CPU, not its file size: a 3-hour movie takes hours on a laptop CPU.

## Stopping, pausing and deleting

Every video row in the admin *Videos* and *Processing Jobs* pages has **Pause** (queued or processing videos) and **Delete** buttons, and the row menu has the rest.

- **Pause** stops the job now (FFmpeg is killed within a couple of seconds, longer if the machine is busy) and holds the video as **Paused**. The original upload is kept, partial output is removed, and the worker is free for the next video. **Resume** starts processing again from the beginning. It is not a freeze-and-continue: FFmpeg cannot be suspended the same way on Windows and Linux.
- **Delete** works at any stage. On a queued or processing video it stops the job first ("Stop & delete"), then removes the original and every processed file. A stopped job is not counted as a failure and is not retried.
- **Delete processed files** removes only the streaming output of a finished, failed or paused video. The video leaves the public site and becomes *Paused* with its original kept, so you can process it again with **Resume**. It is refused if the original upload is gone (use Delete instead).

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
