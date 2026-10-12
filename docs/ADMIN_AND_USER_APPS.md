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

## Stopping, pausing and deleting

Every video row in the admin *Videos* and *Processing Jobs* pages has **Pause** (queued or processing videos) and **Delete** buttons, and the row menu has the rest.

- **Pause** stops the job now (FFmpeg is killed within a couple of seconds, longer if the machine is busy) and holds the video as **Paused**. The original upload is kept, partial output is removed, and the worker is free for the next video. **Resume** starts processing again from the beginning. It is not a freeze-and-continue: FFmpeg cannot be suspended the same way on Windows and Linux.
- **Delete** works at any stage. On a queued or processing video it stops the job first ("Stop & delete"), then removes the original and every processed file. A stopped job is not counted as a failure and is not retried.
- **Delete processed files** removes only the streaming output of a finished, failed or paused video. The video leaves the public site and becomes *Paused* with its original kept, so you can process it again with **Resume**. It is refused if the original upload is gone (use Delete instead).

## What stays on the viewer's device

My List and watch history are stored in the viewer's browser (`localStorage`), because there are no user accounts yet. When you add login, move them to the server keyed by user id.

## Known limits

- **AWS media access:** publishing hides a video from the public API, but S3/CloudFront objects can still be fetched by anyone who knows the URL. For strict privacy on AWS use signed URLs/cookies.
- **Database:** this branch uses the JSON-file database (now with cross-process locking). The DynamoDB branch needs the same two additions: `appendEvent` and `listAll`.
- **Admin sessions** are signed tokens with no server-side store, so they can't be revoked individually; rotating `ADMIN_API_KEY` signs everyone out.
- **Captions:** the old placeholder sample captions are off by default (`ENABLE_PLACEHOLDER_CAPTIONS=true` brings them back).
