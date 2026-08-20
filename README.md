# site-eyes

"What the site looks like in the browser." A REST API on the site-eyes Pi 5
(`192.168.20.193`) that drives headless chromium (Playwright) and returns **only
what a real browser sees** — DevTools data, the rendered DOM, and markup.
`/check` runs no 3rd-party analysis; anything analytical over the persisted
output (visual diff, scoring) is a downstream job. The **one exception is
`POST /a11y`** (below), which runs axe-core *in the page* — it needs the live
DOM, so it can't be a downstream job.

Everything lives on the TrueNAS `WD_Blue3tb/site-eyes` dataset mounted at
`/mnt/shared` (NFS on the Pi, incus disk device on pcPerf, SMB share `site-eyes`
for desktop browsing) — so a reflashed SD card only needs the runtime + service
restored (see `install.sh`).

## Endpoint

`POST http://192.168.20.193:8080/check`
Header: `Authorization: Bearer <token>`  (token in `/mnt/shared/app/.token`)
`GET /health` — no auth.

The request has two independent parts:
- **`commands`** — *actions to DO* on the page (in order).
- **`returns`** — *DevTools/DOM/markup data to GET + PERSIST*. Only the keys you
  set are collected, returned, and written to disk; everything else is dropped.

```jsonc
{
  "url": "https://example.com",
  "viewport": { "width": 1440, "height": 900 },   // optional
  "timeout": 30000,                                 // optional, ms
  "commands": [
    { "action": "goto",       "url": "https://example.com/login", "waitUntil": "load" }, // jump mid-sequence
    { "action": "waitFor",    "timeout": 2000 },              // or { "selector": "#app" }
    { "action": "click",      "selector": "button.accept" },
    { "action": "fill",       "selector": "#q", "text": "hi" },  // type is an alias of fill
    { "action": "select",     "selector": "#country", "value": "GB" },  // value: string or [strings]
    { "action": "check",      "selector": "#terms" },          // check a checkbox / radio
    { "action": "uncheck",    "selector": "#newsletter" },     // uncheck a checkbox
    { "action": "press",      "selector": "#q", "key": "Enter" },  // key: Enter, Tab, Escape…
    { "action": "hover",      "selector": ".menu" },           // reveal menus / tooltips
    { "action": "scroll",     "selector": ".footer" },         // or { "x": 0, "y": 800 } to scroll by px
    { "action": "evaluate",   "script": "return document.title" },
    { "action": "screenshot", "name": "home", "fullPage": true },  // or { "selector": ".hero" }
    { "action": "pdf",        "name": "page" }
  ],
  "returns": {
    "console":      true,                        // log/info/warn/error/pageerror
    "network":      { "categories": ["CSS","JS"], "text": "wp-content", "invert": false },
    "failures":     true,                        // 4xx / 5xx / failed requests
    "headers":      true,                        // response headers per request
    "mixedContent": true,                        // http subresources on an https page
    "summary":      true,                        // request/byte totals by category
    "cookies":      true,
    "storage":      true,                        // localStorage / sessionStorage / IndexedDB
    "perf":         true,                        // navigation + paint timing
    "webVitals":    true,                        // LCP, CLS, INP, FCP, TTFB
    "resources":    true,                        // per-resource timing + sizes
    "metrics":      true,                        // CDP Performance.getMetrics
    "coverage":     true,                        // unused CSS / JS bytes
    "axTree":       true,                        // accessibility tree
    "html":         true,                        // full rendered HTML (post-JS)
    "snippets":     ["title", ".hero", "#nav"],  // outerHTML per selector
    "seo":          true,                        // title, meta, canonical, og:*, h1s, lang
    "domStats":     true,                        // node count / depth / size
    "brokenImages": true,                        // <img> with naturalWidth===0
    "cdp":          [ { "method": "Accessibility.getFullAXTree" } ]  // raw CDP — full DevTools
  }
}
```

### `network` filter
`true` = all requests. Or an object / array:
- `categories`: DevTools Network labels — `All, Fetch/XHR, Doc, CSS, JS, Font, Img, Media, Manifest, Socket, Wasm, Other` (synonyms like `stylesheet`, `script`, `image` accepted).
- `text`: substring match on URL. `invert`: keep everything that does NOT match.
Each request is tagged with its `category` and carries `startMs` + `durationMs` (waterfall).

## Response / persistence

```jsonc
{
  "ok": true,
  "jobId": "2026-07-06T...-a1b2c3",
  "url": "https://example.com",
  "artifactsDir": "/mnt/shared/jobs/<jobId>",   // pcPerf reads files here directly
  "durationMs": 1234,
  "results": [ { "i": 0, "action": "screenshot", "ok": true, "path": ".../home.png" }, ... ],
  "returns": { /* only the keys you asked for */ }
}
```
Every requested return is also written to the job dir: `<key>.json` (and
`content.html` for `html`), alongside any screenshots/PDFs from `commands`.


## Retrieving a job — `GET /jobs/:jobId`

Fetch a past job back over HTTP (Bearer token, same as `/check`):

- `GET /jobs/<jobId>` — one JSON: `{ ok, jobId, artifactsDir, files:[{name,bytes}], data:{...} }`
  where `data` has every `<key>.json` from the job dir parsed and inlined
  (`console`, `network`, `webVitals`, `seo`, `summary`, `coverage`, …).
- `GET /jobs/<jobId>/<file>` — one artifact raw with its content type:
  `page.png` as `image/png`, `content.html` as `text/html`, PDFs, or any
  `<key>.json`. Binary files are intentionally NOT base64d into the job JSON —
  grab them from this route (`curl -o page.png …`).

```bash
curl -s -H "Authorization: Bearer <token>" http://192.168.20.193:8080/jobs/<jobId>
curl -s -H "Authorization: Bearer <token>" -o page.png http://192.168.20.193:8080/jobs/<jobId>/page.png
```

## Accessibility — `POST /a11y`

Runs an **axe-core** WCAG audit in the same Playwright browser (via
`@axe-core/playwright`) — **no chromedriver**, so nothing to keep version-matched
to Chrome. This is the one analytical endpoint: axe has to run against the live
DOM, so it lives here rather than downstream.

`POST http://192.168.20.193:8080/a11y` · Bearer token · body `{ "url", "timeout"?, "viewport"? }`

```jsonc
{
  "ok": true,
  "url": "https://example.com",
  "finalUrl": "https://example.com/",
  "durationMs": 723,
  "engine": { "name": "axe-core", "version": "4.12.1" },
  "violations": [
    { "id": "image-alt", "impact": "critical|serious|moderate|minor",
      "description": "...", "help": "...", "helpUrl": "https://dequeuniversity.com/...",
      "nodes": [ { "target": ["img"], "html": "<img …>", "failureSummary": "…" } ], // capped at 50
      "nodeCount": 3 }
  ],
  "incomplete": [ { "id": "color-contrast", "impact": "serious", "nodeCount": 2 } ], // needs-review rules
  "counts": { "violations": 1, "incomplete": 1, "passes": 42 }
}
```
Consumed by pcPerf's SiteAccessibility **`axe-a11y`** tool, which folds `impact`
onto the shared error/warning/notice buckets. Deps: `@axe-core/playwright` +
`axe-core` (in `package.json`).

## Resilience  [added 2026-08-01]

Hardening after the 2026-08-01 outage: the shared chromium grew to ~5 GB under
CF3000 stage-4 load and was OOM-killed by the kernel; the server kept accepting
requests, all 3 pool slots leaked, every `/check` queued forever — while
`/health` still said ok.

- **Browser death self-heals**: `browser.on('disconnected')` exits the process;
  systemd (`Restart=on-failure`, 3 s) relaunches with a fresh browser and an
  empty queue.
- **`/health` is honest**: returns `ok: browser.isConnected()` (HTTP 503 when
  false), so a dead browser is visible to callers and monitoring.
- **No slot leaks**: browser contexts are created inside the try/finally that
  releases the pool slot.
- **Per-job hard cap**: `SITE_EYES_JOB_TIMEOUT_MS` (default 90000) closes the
  job's context — a hung page can't hold a slot forever.
- **Caller-gone abort**: if the client disconnects (e.g. its own timeout)
  mid-job or while queued, the job is killed instead of running on — abandoned
  jobs piling up contexts is what fed the OOM.

## Notes
- Synchronous: the request blocks until done. Parallel callers are served by a
  bounded worker pool (`SITE_EYES_WORKERS`, default 3).
- `evaluate` runs arbitrary caller JS **in the page context** (not the host).
- `cdp` = the whole Chrome DevTools Protocol; the named keys are shortcuts over
  the common domains. Anything not named is one `cdp` call away.
- `coverage` starts before navigation; `headers` are captured only when requested.
- Service: `sudo systemctl {status,restart} site-eyes` on the Pi.
