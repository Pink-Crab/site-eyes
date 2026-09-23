// server.js — site-eyes: browser-check REST API backed by a Playwright worker pool.
// POST /check { url, commands:[actions to DO], returns:{devtools data to GET+PERSIST} }
import Fastify from 'fastify';
import { chromium } from 'playwright';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { runCommands } from './executor.js';
import { collectReturns } from './collect.js';
import { AxeBuilder } from '@axe-core/playwright';

const PORT = Number(process.env.SITE_EYES_PORT || 8080);
const JOBS_DIR = process.env.SITE_EYES_JOBS || '/mnt/shared/jobs';
const MAX_WORKERS = Number(process.env.SITE_EYES_WORKERS || 3);
const JOB_TIMEOUT_MS = Number(process.env.SITE_EYES_JOB_TIMEOUT_MS || 90000);
const TOKEN_FILE = process.env.SITE_EYES_TOKEN_FILE || '/mnt/shared/app/.token';
const RECENT_MAX = Number(process.env.SITE_EYES_RECENT || 200);

const token = (await fs.readFile(TOKEN_FILE, 'utf8')).trim();

// in-flight jobs, and a ring buffer of the last RECENT_MAX finished ones
const running = new Map();
const recent = [];
const jobStart = (id, kind, url) => { running.set(id, { jobId: id, kind, url, startedAt: Date.now() }); };
const jobEnd = (id, ok, error) => {
  const j = running.get(id);
  running.delete(id);
  if (!j) return;
  recent.unshift({ ...j, ok, error: error || null, durationMs: Date.now() - j.startedAt, finishedAt: Date.now() });
  if (recent.length > RECENT_MAX) recent.length = RECENT_MAX;
};

// one browser for the process; each job gets an isolated context, bounded by a semaphore.
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
// if the shared browser dies (e.g. OOM), exit — systemd relaunches us clean
browser.on('disconnected', () => process.exit(1));

let active = 0;
const waiters = [];
const acquire = () => new Promise((res) => (active < MAX_WORKERS ? (active++, res()) : waiters.push(res)));
const release = () => { active--; const next = waiters.shift(); if (next) { active++; next(); } };

const app = Fastify({ logger: true, bodyLimit: 5 * 1024 * 1024 });

// bearer auth on everything except /health and the read-only GUI.
// the GUI is exempt only over loopback — nginx proxies it from 127.0.0.1 behind
// basic auth, so it never answers unauthenticated to anything off-box.
const isLoopback = (req) => req.ip === '127.0.0.1' || req.ip === '::1' || req.ip === '::ffff:127.0.0.1';
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
  if (req.url.startsWith('/ui') && isLoopback(req)) return;
  const auth = req.headers.authorization || '';
  const got = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  const ok = got.length === token.length && crypto.timingSafeEqual(Buffer.from(got), Buffer.from(token));
  if (!ok) return reply.code(401).send({ ok: false, error: 'unauthorized' });
});

app.get('/health', async (req, reply) => {
  const ok = browser.isConnected();
  if (!ok) reply.code(503);
  return { ok, active, max: MAX_WORKERS };
});

// GET /jobs/:jobId — the job's data in one JSON: every <key>.json inlined under
// data, plus a file manifest. Binary/large artifacts (page.png, content.html,
// PDFs) are fetched raw via GET /jobs/:jobId/:file.
const safeName = (s) => typeof s === 'string' && s.length > 0 && !/[/\\]|\.\./.test(s);
const MIME = { '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.pdf': 'application/pdf', '.html': 'text/html' };

async function readJob(jobId, reply) {
  const jobDir = path.join(JOBS_DIR, jobId);
  let names;
  try { names = await fs.readdir(jobDir); } catch { return reply.code(404).send({ ok: false, error: 'job not found' }); }
  const files = [];
  const data = {};
  for (const name of names.sort()) {
    const st = await fs.stat(path.join(jobDir, name)).catch(() => null);
    if (!st || !st.isFile()) continue;
    files.push({ name, bytes: st.size });
    if (name.endsWith('.json')) {
      const raw = await fs.readFile(path.join(jobDir, name), 'utf8');
      try { data[name.slice(0, -5)] = JSON.parse(raw); } catch { data[name.slice(0, -5)] = raw; }
    }
  }
  return { ok: true, jobId, artifactsDir: jobDir, files, data };
}

app.get('/jobs/:jobId', async (req, reply) => {
  const { jobId } = req.params;
  if (!safeName(jobId)) return reply.code(400).send({ ok: false, error: 'bad jobId' });
  return readJob(jobId, reply);
});

// GET /jobs/:jobId/:file — stream one artifact raw with its content type
app.get('/jobs/:jobId/:file', async (req, reply) => {
  const { jobId, file } = req.params;
  if (!safeName(jobId) || !safeName(file)) return reply.code(400).send({ ok: false, error: 'bad path' });
  let buf;
  try { buf = await fs.readFile(path.join(JOBS_DIR, jobId, file)); } catch { return reply.code(404).send({ ok: false, error: 'not found' }); }
  return reply.type(MIME[path.extname(file).toLowerCase()] || 'application/octet-stream').send(buf);
});

// ---- read-only GUI (loopback + nginx basic auth) ----

// canonical path is /ui/ — the page uses relative fetches so it works under any nginx sub-path
app.get('/ui', async (req, reply) => reply.redirect(301, '/ui/'));
app.get('/ui/', async (req, reply) => {
  const html = await fs.readFile(new URL('./public/ui.html', import.meta.url), 'utf8');
  return reply.type('text/html; charset=utf-8').send(html);
});

// current: what the pool is doing right now, plus the recent ring
app.get('/ui/api/state', async () => ({
  ok: browser.isConnected(),
  active,
  max: MAX_WORKERS,
  queued: waiters.length,
  now: Date.now(),
  running: [...running.values()].sort((a, b) => a.startedAt - b.startedAt),
  recent,
}));

// past: paged listing straight off the jobs dir, newest first (ids sort chronologically)
app.get('/ui/api/jobs', async (req) => {
  const limit = Math.min(Number(req.query.limit) || 50, 200);
  const offset = Math.max(Number(req.query.offset) || 0, 0);
  const q = (req.query.q || '').trim();
  let names = await fs.readdir(JOBS_DIR).catch(() => []);
  names = names.filter((n) => safeName(n)).sort().reverse();
  if (q) names = names.filter((n) => n.includes(q));
  const page = names.slice(offset, offset + limit);
  const jobs = [];
  for (const name of page) {
    const files = await fs.readdir(path.join(JOBS_DIR, name)).catch(() => []);
    const st = await fs.stat(path.join(JOBS_DIR, name)).catch(() => null);
    jobs.push({ jobId: name, at: st ? st.mtimeMs : null, fileCount: files.length, files });
  }
  return { ok: true, total: names.length, offset, limit, jobs };
});

// The GUI gets the manifest only — never the inlined data. A job with
// network.json + coverage.json is hundreds of KB, which is unreadable as one
// blob and big enough to wreck the page. Individual files are one click away.
app.get('/ui/api/jobs/:jobId', async (req, reply) => {
  const { jobId } = req.params;
  if (!safeName(jobId)) return reply.code(400).send({ ok: false, error: 'bad jobId' });
  const jobDir = path.join(JOBS_DIR, jobId);
  let names;
  try { names = await fs.readdir(jobDir); } catch { return reply.code(404).send({ ok: false, error: 'job not found' }); }
  const files = [];
  for (const name of names.sort()) {
    const st = await fs.stat(path.join(jobDir, name)).catch(() => null);
    if (st && st.isFile()) files.push({ name, bytes: st.size });
  }
  return { ok: true, jobId, artifactsDir: jobDir, files };
});

app.get('/ui/api/jobs/:jobId/:file', async (req, reply) => {
  const { jobId, file } = req.params;
  if (!safeName(jobId) || !safeName(file)) return reply.code(400).send({ ok: false, error: 'bad path' });
  let buf;
  try { buf = await fs.readFile(path.join(JOBS_DIR, jobId, file)); } catch { return reply.code(404).send({ ok: false, error: 'not found' }); }
  return reply.type(MIME[path.extname(file).toLowerCase()] || 'application/octet-stream').send(buf);
});

app.post('/check', async (req, reply) => {
  const body = req.body || {};
  if (!body.url) return reply.code(400).send({ ok: false, error: 'url required' });
  const commands = Array.isArray(body.commands) ? body.commands : [];
  const returnsSpec = body.returns && typeof body.returns === 'object' ? body.returns : {};
  const timeout = Number(body.timeout || 30000);
  const wantHeaders = !!returnsSpec.headers;
  const wantCoverage = !!returnsSpec.coverage;

  const jobId = `${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  const jobDir = path.join(JOBS_DIR, jobId);
  await fs.mkdir(jobDir, { recursive: true });

  // Watch the RESPONSE, not the request: node fires 'close' on the request stream as
  // soon as the body has been read, so a request-side listener marks every caller as
  // gone before the job starts. That is what made /a11y refuse every request.
  let clientGone = false;
  reply.raw.on('close', () => { if (!reply.sent) clientGone = true; });

  await acquire();
  jobStart(jobId, 'check', body.url);
  const started = Date.now();
  const consoleMsgs = [];
  const network = [];
  let context = null;
  let watchdog = null;
  try {
    if (clientGone) return { ok: false, jobId, error: 'client disconnected while queued' };
    context = await browser.newContext({ viewport: body.viewport || { width: 1366, height: 768 }, ignoreHTTPSErrors: true });
    // hard cap + caller-gone abort: closing the context makes the job reject, freeing its slot
    const killJob = () => context.close().catch(() => {});
    watchdog = setTimeout(killJob, JOB_TIMEOUT_MS);
    req.raw.on('close', () => { if (!reply.sent) killJob(); });
    // optional caller cookies, set before the first navigation; cookies without url/domain default to body.url
    if (Array.isArray(body.cookies) && body.cookies.length) {
      await context.addCookies(body.cookies.map((c) => (c.url || c.domain ? c : { ...c, url: body.url })));
    }
    const page = await context.newPage();
    page.on('console', (m) => consoleMsgs.push({ type: m.type(), text: m.text() }));
    // String(e) on a thrown plain object collapses to "Object" and loses the lot.
    page.on('pageerror', (e) => consoleMsgs.push({
      type: 'pageerror',
      text: (e && e.message) || String(e),
      name: e && e.name,
      stack: e && e.stack,
      raw: (() => { try { return JSON.stringify(e); } catch { return undefined; } })(),
    }));
    page.on('requestfinished', async (rq) => {
      try {
        const resp = await rq.response();
        const t = rq.timing();
        const entry = { url: rq.url(), method: rq.method(), type: rq.resourceType(), status: resp ? resp.status() : null, startMs: t.startTime, durationMs: t.responseEnd >= 0 ? Math.round(t.responseEnd) : null };
        if (wantHeaders && resp) entry.headers = resp.headers();
        network.push(entry);
      } catch {}
    });
    page.on('requestfailed', (rq) => {
      try {
        const t = rq.timing();
        network.push({ url: rq.url(), method: rq.method(), type: rq.resourceType(), status: null, failed: true, errorText: (rq.failure() && rq.failure().errorText) || null, startMs: t && t.startTime, durationMs: null });
      } catch {}
    });
    const cdp = await context.newCDPSession(page);

    // coverage must start before navigation
    if (wantCoverage) {
      await page.coverage.startJSCoverage({ resetOnNavigation: false }).catch(() => {});
      await page.coverage.startCSSCoverage({ resetOnNavigation: false }).catch(() => {});
    }

    // implicit first navigation to the requested url
    await page.goto(body.url, { waitUntil: 'load', timeout }).catch((e) => consoleMsgs.push({ type: 'goto-error', text: String(e) }));

    const ctx = { url: body.url, timeout, jobDir, console: consoleMsgs, network };

    // 1) run the ACTIONS
    const results = await runCommands(page, commands.map((c, i) => ({ ...c, _i: i })), ctx);
    // 2) collect ONLY the requested DevTools DATA
    const returns = await collectReturns(page, cdp, returnsSpec, ctx);

    // 3) persist ONLY what was asked for — one file per return key; the rest is dropped
    for (const [k, v] of Object.entries(returns)) {
      if (k === 'html') await fs.writeFile(path.join(jobDir, 'content.html'), String(v || ''));
      else await fs.writeFile(path.join(jobDir, `${k}.json`), JSON.stringify(v, null, 2));
    }

    jobEnd(jobId, true);
    return { ok: true, jobId, url: body.url, artifactsDir: jobDir, durationMs: Date.now() - started, results, returns };
  } catch (err) {
    reply.code(500);
    jobEnd(jobId, false, String((err && err.message) || err));
    return { ok: false, jobId, artifactsDir: jobDir, error: String((err && err.message) || err) };
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (context) await context.close().catch(() => {});
    running.delete(jobId);
    release();
  }
});

// POST /a11y { url, timeout?, viewport? } — axe-core WCAG audit via the same
// Playwright browser (no chromedriver). Returns the violations (impact + nodes)
// and the incomplete (needs-review) rules.
app.post('/a11y', async (req, reply) => {
  const body = req.body || {};
  if (!body.url) return reply.code(400).send({ ok: false, error: 'url required' });
  const timeout = Number(body.timeout || 30000);
  const maxNodes = 50;

  // Watch the RESPONSE, not the request: node fires 'close' on the request stream as
  // soon as the body has been read, so a request-side listener marks every caller as
  // gone before the job starts. That is what made /a11y refuse every request.
  let clientGone = false;
  reply.raw.on('close', () => { if (!reply.sent) clientGone = true; });

  const a11yId = `a11y-${new Date().toISOString().replace(/[:.]/g, '-')}-${crypto.randomBytes(3).toString('hex')}`;
  await acquire();
  jobStart(a11yId, 'a11y', body.url);
  const started = Date.now();
  let context = null;
  let watchdog = null;
  try {
    if (clientGone) return { ok: false, url: body.url, error: 'client disconnected while queued' };
    context = await browser.newContext({ viewport: body.viewport || { width: 1366, height: 768 }, ignoreHTTPSErrors: true });
    const killJob = () => context.close().catch(() => {});
    watchdog = setTimeout(killJob, JOB_TIMEOUT_MS);
    req.raw.on('close', () => { if (!reply.sent) killJob(); });
    const page = await context.newPage();
    await page.goto(body.url, { waitUntil: 'load', timeout });
    const results = await new AxeBuilder({ page }).analyze();

    const violations = (results.violations || []).map((v) => ({
      id: v.id, impact: v.impact || 'minor', description: v.description, help: v.help, helpUrl: v.helpUrl,
      nodes: (v.nodes || []).slice(0, maxNodes).map((n) => ({ target: n.target, html: (n.html || '').slice(0, 400), failureSummary: n.failureSummary })),
      nodeCount: (v.nodes || []).length,
    }));
    const incomplete = (results.incomplete || []).map((i) => ({ id: i.id, impact: i.impact || null, nodeCount: (i.nodes || []).length }));

    jobEnd(a11yId, true);
    return {
      ok: true, url: body.url, finalUrl: page.url(), durationMs: Date.now() - started,
      engine: results.testEngine, violations, incomplete,
      counts: { violations: violations.length, incomplete: incomplete.length, passes: (results.passes || []).length },
    };
  } catch (err) {
    reply.code(500);
    jobEnd(a11yId, false, String((err && err.message) || err));
    return { ok: false, url: body.url, error: String((err && err.message) || err) };
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (context) await context.close().catch(() => {});
    running.delete(a11yId);
    release();
  }
});

const shutdown = async () => { await app.close().catch(() => {}); await browser.close().catch(() => {}); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: PORT });
