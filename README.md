# site-eyes

**"What the site looks like in a real browser."** A small, synchronous REST API
that drives headless Chromium (Playwright) and returns only what a browser
actually sees: DevTools data (network, console, performance, coverage), the
rendered DOM, and markup. Post a URL and a list of what you want back; the
response arrives when the capture is done, and every artifact is persisted to a
job directory you can fetch later over HTTP.

`/check` runs no third-party analysis — anything analytical (scoring, visual
diffing) is meant to be a downstream job over the persisted output. The one
exception is `POST /a11y`, which runs an axe-core WCAG audit in the page,
because axe needs the live DOM.

Machine-focused usage — request/response shapes with real captured examples —
is in [`AGENTS.md`](AGENTS.md).

## Endpoints

| Route | Auth | What it does |
|---|---|---|
| `POST /check` | Bearer | run a capture: `commands` to DO, `returns` to COLLECT |
| `GET /health` | none | `{ok, active, max}` — `ok:false` + HTTP 503 when the browser is dead |
| `GET /jobs/:jobId` | Bearer | a past job with every collected `<key>.json` inlined |
| `GET /jobs/:jobId/:file` | Bearer | one raw artifact (`page.png`, `content.html`, PDFs, any `<key>.json`) |
| `POST /a11y` | Bearer | axe-core audit: `{url, timeout?, viewport?}` |

## The `/check` request

Two independent parts:

- **`commands`** — actions to *do* on the page, in order: `goto`, `waitFor`,
  `click`, `fill`/`type`, `select`, `check`, `uncheck`, `press`, `hover`,
  `scroll`, `evaluate`, `screenshot`, `pdf`.
- **`returns`** — DevTools/DOM/markup data to *collect and persist*. Only the
  keys you ask for are gathered: `console`, `network` (filterable by DevTools
  category and URL substring), `failures`, `headers`, `mixedContent`,
  `summary`, `cookies`, `storage`, `perf`, `webVitals`, `resources`,
  `metrics`, `coverage` (unused CSS/JS bytes), `axTree`, `html`, `snippets`,
  `seo`, `domStats`, `brokenImages`, and a raw `cdp` escape hatch into the
  full Chrome DevTools Protocol.

```bash
curl -s -X POST http://localhost:8080/check \
  -H "Authorization: Bearer $(cat .token)" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://example.com","returns":{"webVitals":true,"seo":true}}'
```

Every requested return is also written to the job directory as `<key>.json`
(plus `content.html` for `html`, and any screenshots/PDFs), so a capture can be
re-read forever via `GET /jobs/:jobId` without re-running it.

### Caching: `POST /check?cache=<seconds>`

Add `?cache=<seconds>` and an identical request answered within that many
seconds comes back from the earlier job instead of opening a browser. The
response gains `cached: true` and `ageSeconds`, and carries the original
`jobId`, `results` and `returns`. Without the parameter every call runs fresh
(`cached: false`).

"Identical" means the same `url`, `commands`, `returns`, `cookies`, `viewport`
and `timeout`, compared with keys sorted. Every successful `/check` writes a
small index file to `SITE_EYES_CACHE`, `<sha256>.json`, naming the job and
when it ran; the data itself is read back from that job's folder, so nothing
is stored twice. If any of the job's files are gone, the call runs fresh.

```bash
curl -s -X POST "http://localhost:8080/check?cache=1500" ...   # reuse anything under 25 minutes old
```

## Install

Requirements: Node ≥ 22.9 (see `engines` in `package.json`).

```bash
npm install
npx playwright install --with-deps chromium
cp .env.example .env                                      # then edit as needed
head -c 32 /dev/urandom | xxd -p -c 64 > .token && chmod 600 .token
npm start
```

## Configuration

Environment variables only, all optional. Copy `.env.example` to `.env` and
adjust — `npm start` loads it via Node's `--env-file-if-exists`, and the
systemd unit loads the same file via `EnvironmentFile=`.

| Variable | Code default | Meaning |
|---|---|---|
| `SITE_EYES_PORT` | `8080` | listen port (binds `0.0.0.0`) |
| `SITE_EYES_WORKERS` | `3` | bounded worker pool — parallel captures |
| `SITE_EYES_JOB_TIMEOUT_MS` | `90000` | hard cap per job; the job's browser context is closed |
| `SITE_EYES_JOBS` | `/mnt/shared/jobs` | where job artifact directories are written (created on demand) |
| `SITE_EYES_CACHE` | `cache/` beside `SITE_EYES_JOBS` | where `/check?cache=` keeps its per-request index files |
| `SITE_EYES_TOKEN_FILE` | `/mnt/shared/app/.token` | file holding the bearer token — the server refuses to start without it |
| `PLAYWRIGHT_BROWSERS_PATH` | Playwright default | where Chromium lives (read by Playwright itself) |

The two path defaults suit the original deployment; on a fresh clone set them
in `.env` (`.env.example` ships `./jobs` and `./.token`).

`site-eyes.service` is a reference systemd unit — adjust its paths to your
install and enable it for restart-on-failure supervision.

**The token file is the only credential.** It is git-ignored; keep it that way.
Anyone with the token can drive a browser from your network (`evaluate` runs
arbitrary JS in the page), so treat it like an SSH key and keep the service
off the public internet.

## Resilience

Lessons from production baked in:

- A dead/disconnected browser exits the process; systemd relaunches it fresh
  (`Restart=on-failure`). The queue is lost — callers re-submit.
- `/health` tells the truth: it reports the browser's real connection state,
  returning 503 rather than a hollow `ok`.
- Worker-pool slots are released in `finally` — no slot leaks from crashed jobs.
- If a caller disconnects mid-job or while queued, the job is aborted instead
  of running on unattended.
- Per-job hard timeout (`SITE_EYES_JOB_TIMEOUT_MS`) — a hung page cannot hold
  a pool slot forever.

## Layout

| File | Role |
|---|---|
| `server.js` | Fastify API: auth, worker pool, job persistence, routes |
| `executor.js` | runs the `commands` sequence against the page |
| `collect.js` | gathers every `returns` key (CDP + in-page evaluation) |
| `site-eyes.service` | reference systemd unit |
| `AGENTS.md` | machine-focused API reference with real response shapes |
