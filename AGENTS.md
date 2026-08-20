# AGENTS.md — driving site-eyes

Machine-focused reference. Human overview and install: `README.md`.
Every shape below is either taken from a real capture or from `collect.js`.

## Endpoints

```
POST <host>:<port>/check            Authorization: Bearer <token>
GET  <host>:<port>/health           no auth
GET  <host>:<port>/jobs/<jobId>     Bearer — past job, artifacts inlined
GET  <host>:<port>/jobs/<jobId>/<file>   Bearer — one raw artifact
POST <host>:<port>/a11y             Bearer — axe-core audit
```

The token is never in this repo. The server reads it at startup from
`SITE_EYES_TOKEN_FILE`; get its value from the deployment.

Calls are **synchronous** — `/check` blocks until the capture finishes. Use a
client timeout of at least 120s. `SITE_EYES_WORKERS` (default 3) captures run
in parallel; extra callers queue. If you disconnect while queued or mid-job,
the job is killed.

## Pre-flight

```
GET /health   → 200 {"ok":true,"active":0,"max":3}
              → 503 {"ok":false,...}   browser dead; systemd is relaunching it
```

Back off when `active == max`. Retry once on connection errors — a browser
crash loses the queue but the service self-heals in seconds.

## A perf-profile call and its real response

```bash
curl -s -X POST "$HOST/check" -H "Authorization: Bearer $TOKEN" \
  -H "Content-Type: application/json" -d '{
  "url": "https://example.com",
  "viewport": { "width": 1366, "height": 768 },
  "timeout": 30000,
  "commands": [{ "action": "screenshot", "name": "page", "fullPage": true }],
  "returns": { "summary": true, "webVitals": true, "coverage": true,
               "seo": true, "failures": true, "console": true, "network": true }
}'
```

Real response (a live e-commerce site, arrays trimmed to one element):

```jsonc
{
  "ok": true,
  "jobId": "2026-08-20T13-21-45-641Z-000d12",
  "url": "https://www.example-shop.com/",
  "artifactsDir": "<SITE_EYES_JOBS>/2026-08-20T13-21-45-641Z-000d12",
  "durationMs": 10814,
  "results": [
    { "i": 0, "action": "screenshot", "ok": true, "path": ".../page.png" }
  ],
  "returns": {
    "webVitals": { "ttfb": 1361, "fcp": 2356, "lcp": 3712, "cls": 0.012, "inp": null },
    "summary": {
      "totalRequests": 84, "failed": 5,
      "byCategory": { "Doc": 1, "CSS": 16, "JS": 37, "Img": 20, "Font": 3, "Fetch/XHR": 6, "Other": 1 },
      "byStatus": { "200": 78, "204": 1, "404": 1, "failed": 4 }
    },
    "coverage": {
      "css": { "totalBytes": 565080, "usedBytes": 40570, "unusedBytes": 524510, "unusedPct": 93,
               "files": [ { "url": ".../bootstrap.css", "totalBytes": 125815, "usedBytes": 7104, "unusedBytes": 118711 } ] },
      "js":  { /* same rollup shape */ }
    },
    "seo": {
      "title": "Example Shop", "description": "…", "canonical": null,
      "robots": "INDEX,FOLLOW", "viewport": "width=device-width…", "lang": "en",
      "h1": ["logout", "login"],
      "og": { "title": null, "description": null, "image": null, "url": null, "type": null }
    },
    "network": [
      { "url": "https://www.example-shop.com/", "method": "GET", "type": "document",
        "status": 200, "startMs": 1787232105759.45, "durationMs": 1379, "category": "Doc" }
    ],
    "console": [
      { "type": "error", "text": "Failed to load resource: the server responded with a status of 404 ()" }
    ],
    "failures": [
      { "url": ".../cc-holder.png", "status": 404, "failed": false, "errorText": null, "category": "Img" }
    ]
  }
}
```

## Reading the numbers

- `webVitals`: all ms except `cls` (unitless, 3dp). `inp` is null unless your
  `commands` actually interact. `lcp`/`cls` come from buffered
  PerformanceObservers sampled ~300ms after load — treat as lab values.
- LCP "good" is ≤2500ms, TTFB "good" is ≤800ms, CLS "good" is ≤0.1.
- Single runs vary ±30%; run ≥3 and average before comparing anything.
- **HTTP status of the main document** is NOT a top-level field: take the
  first `network` entry with `type == "document"` (or `category == "Doc"`)
  and read its `status`.
- `failures` = requests that failed at network level (`failed:true`,
  `errorText` set) OR answered ≥400.
- `console` types: `log|info|warn|error|pageerror`.
- `coverage` unused bytes are measured from navigation start; `unusedPct` is
  per-rollup, with per-file detail under `files`.
- `network.startMs` is epoch ms; subtract the Doc entry's to build a waterfall.
  Filter server-side instead of pulling everything:
  `"network": { "categories": ["JS","CSS"], "text": "wp-content", "invert": false }`.

## Other `returns` keys (shapes from collect.js)

| Key | Shape |
|---|---|
| `headers` | `[{url, status, category, headers:{...}}]` — every request's response headers |
| `mixedContent` | `[{url, category}]` — http:// subresources on an https page (empty array on http pages) |
| `cookies` | Playwright `context().cookies()` array |
| `storage` | `{localStorage:{k:v}, sessionStorage:{k:v}, indexedDB:[{name,version}]}` |
| `perf` | `{navigation:{ttfbMs,domInteractiveMs,domContentLoadedMs,loadMs,transferSize,encodedBodySize,decodedBodySize}, paints:[{name,startMs}]}` |
| `resources` | `[{name,type,startMs,durationMs,transferSize,encodedBodySize,decodedBodySize}]` per resource |
| `metrics` | raw CDP `Performance.getMetrics` array `[{name,value}]` |
| `axTree` | raw CDP `Accessibility.getFullAXTree` nodes |
| `html` | full post-JS rendered HTML — heavy; request only when needed |
| `snippets` | `[{selector, found, html}]` per requested selector |
| `domStats` | `{nodes, maxDepth, htmlBytes}` |
| `brokenImages` | `[{src, alt}]` for `<img>` with `naturalWidth === 0` |
| `cdp` | `[{method, result}]` or `[{method, error}]` — any raw DevTools call |

Persistence: every requested key is also written to the job dir as
`<key>.json`; fetch old jobs with `GET /jobs/<jobId>` (all JSON inlined under
`data`, plus a `files` manifest) or one file raw via `GET /jobs/<jobId>/<file>`.
Screenshots/PDFs are never base64d into JSON — always fetch them by file.

## Failure responses (from server.js)

| Case | Status | Body |
|---|---|---|
| bad/missing token | 401 | `{"ok":false,"error":"unauthorized"}` |
| missing `url` | 400 | `{"ok":false,"error":"url required"}` |
| capture crashed / page unreachable | 500 | `{"ok":false,"jobId":…,"artifactsDir":…,"error":"<message>"}` |
| client disconnected while queued | — | `{"ok":false,"jobId":…,"error":"client disconnected while queued"}` |
| unknown job | 404 | `{"ok":false,"error":"job not found"}` |
| browser dead | 503 on `/health` | `{"ok":false,…}` |

Treat any `ok:false` as a per-URL failure, not a service failure — record the
`error` and move on; only 503/connection-refused means stop the batch.

## `/a11y`

`POST /a11y` body `{url, timeout?, viewport?}` → axe-core results:
`{ok, url, finalUrl, durationMs, engine:{name,version}, violations:[{id, impact, description, help, helpUrl, nodes:[{target, html, failureSummary}], nodeCount}], incomplete:[…], counts:{violations, incomplete, passes}}`.
`nodes` is capped at 50 per rule; `impact` ∈ critical|serious|moderate|minor.

## Safety

- `evaluate` (and `cdp`) run arbitrary code in the page/browser — never put
  secrets in scripts, and never point the service at pages you don't trust
  with your egress IP.
- Do not commit or log the bearer token; reference it only by file path.
