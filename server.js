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

const token = (await fs.readFile(TOKEN_FILE, 'utf8')).trim();

// one browser for the process; each job gets an isolated context, bounded by a semaphore.
const browser = await chromium.launch({ headless: true, args: ['--no-sandbox', '--disable-dev-shm-usage'] });
// if the shared browser dies (e.g. OOM), exit — systemd relaunches us clean
browser.on('disconnected', () => process.exit(1));

let active = 0;
const waiters = [];
const acquire = () => new Promise((res) => (active < MAX_WORKERS ? (active++, res()) : waiters.push(res)));
const release = () => { active--; const next = waiters.shift(); if (next) { active++; next(); } };

const app = Fastify({ logger: true, bodyLimit: 5 * 1024 * 1024 });

// bearer auth on everything except /health
app.addHook('onRequest', async (req, reply) => {
  if (req.url === '/health') return;
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

app.get('/jobs/:jobId', async (req, reply) => {
  const { jobId } = req.params;
  if (!safeName(jobId)) return reply.code(400).send({ ok: false, error: 'bad jobId' });
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
});

// GET /jobs/:jobId/:file — stream one artifact raw with its content type
app.get('/jobs/:jobId/:file', async (req, reply) => {
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

  let clientGone = false;
  req.raw.on('close', () => { if (!reply.sent) clientGone = true; });

  await acquire();
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
    page.on('pageerror', (e) => consoleMsgs.push({ type: 'pageerror', text: String(e) }));
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

    return { ok: true, jobId, url: body.url, artifactsDir: jobDir, durationMs: Date.now() - started, results, returns };
  } catch (err) {
    reply.code(500);
    return { ok: false, jobId, artifactsDir: jobDir, error: String((err && err.message) || err) };
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (context) await context.close().catch(() => {});
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

  let clientGone = false;
  req.raw.on('close', () => { if (!reply.sent) clientGone = true; });

  await acquire();
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

    return {
      ok: true, url: body.url, finalUrl: page.url(), durationMs: Date.now() - started,
      engine: results.testEngine, violations, incomplete,
      counts: { violations: violations.length, incomplete: incomplete.length, passes: (results.passes || []).length },
    };
  } catch (err) {
    reply.code(500);
    return { ok: false, url: body.url, error: String((err && err.message) || err) };
  } finally {
    if (watchdog) clearTimeout(watchdog);
    if (context) await context.close().catch(() => {});
    release();
  }
});

const shutdown = async () => { await app.close().catch(() => {}); await browser.close().catch(() => {}); process.exit(0); };
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);

await app.listen({ host: '0.0.0.0', port: PORT });
