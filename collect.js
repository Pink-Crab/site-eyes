// collect.js — gathers the DevTools / DOM / markup DATA named in the `returns` spec.
// Only requested keys are collected; everything else is dropped. No 3rd-party tools.

// Playwright resourceType → DevTools Network-panel category
const CAT = {
  document: 'Doc', stylesheet: 'CSS', script: 'JS', font: 'Font', image: 'Img',
  media: 'Media', fetch: 'Fetch/XHR', xhr: 'Fetch/XHR', eventsource: 'Fetch/XHR',
  preflight: 'Fetch/XHR', websocket: 'Socket', manifest: 'Manifest',
  texttrack: 'Other', ping: 'Other', cspviolationreport: 'Other', other: 'Other',
};
const categoryOf = (r) => (/\.wasm(\?|$)/i.test(r.url || '') ? 'Wasm' : CAT[r.type] || 'Other');

const SYN = {
  'fetch/xhr': 'Fetch/XHR', fetch: 'Fetch/XHR', xhr: 'Fetch/XHR', doc: 'Doc', document: 'Doc',
  css: 'CSS', stylesheet: 'CSS', js: 'JS', script: 'JS', javascript: 'JS', font: 'Font',
  img: 'Img', image: 'Img', media: 'Media', manifest: 'Manifest', socket: 'Socket',
  websocket: 'Socket', ws: 'Socket', wasm: 'Wasm', other: 'Other', all: 'All',
};
const resolveCat = (s) => SYN[String(s).trim().toLowerCase()] || String(s);

function filterNetwork(entries, spec) {
  const list = entries.map((r) => ({ ...r, category: categoryOf(r) }));
  if (spec === true) return list;
  const opt = Array.isArray(spec) ? { categories: spec } : (spec || {});
  const cats = (opt.categories || []).map(resolveCat);
  const useCats = cats.length && !cats.includes('All');
  const text = opt.text ? String(opt.text).toLowerCase() : null;
  const inv = !!opt.invert;
  return list.filter((r) => {
    let keep = true;
    if (useCats) keep = cats.includes(r.category);
    if (keep && text) keep = (r.url || '').toLowerCase().includes(text);
    return inv ? !keep : keep;
  });
}

// union length of covered byte ranges (for coverage)
const unionLen = (ranges) => {
  const s = ranges.slice().sort((a, b) => a[0] - b[0]);
  let len = 0, end = -1;
  for (const [a, b] of s) { const st = Math.max(a, end); if (b > st) len += b - st; if (b > end) end = b; }
  return len;
};
const rollup = (files) => {
  let t = 0, u = 0;
  for (const f of files) { t += f.totalBytes; u += f.usedBytes; }
  return { totalBytes: t, usedBytes: u, unusedBytes: t - u, unusedPct: t ? Math.round((t - u) / t * 100) : 0, files };
};

export async function collectReturns(page, cdp, spec, ctx) {
  const out = {};
  if (!spec || typeof spec !== 'object') return out;

  // ---- DevTools · Network ----
  if (spec.console) out.console = ctx.console.slice();
  if (spec.network) out.network = filterNetwork(ctx.network, spec.network);
  if (spec.failures) {
    out.failures = ctx.network
      .filter((r) => r.failed || (typeof r.status === 'number' && r.status >= 400))
      .map((r) => ({ url: r.url, status: r.status, failed: !!r.failed, errorText: r.errorText || null, category: categoryOf(r) }));
  }
  if (spec.headers) out.headers = ctx.network.map((r) => ({ url: r.url, status: r.status, category: categoryOf(r), headers: r.headers || {} }));
  if (spec.mixedContent) {
    const https = /^https:/i.test(ctx.url);
    out.mixedContent = https ? ctx.network.filter((r) => /^http:\/\//i.test(r.url)).map((r) => ({ url: r.url, category: categoryOf(r) })) : [];
  }
  if (spec.summary) {
    const byCategory = {}, byStatus = {}; let failed = 0;
    for (const r of ctx.network) {
      const c = categoryOf(r); byCategory[c] = (byCategory[c] || 0) + 1;
      const s = r.failed ? 'failed' : (r.status == null ? '?' : String(r.status)); byStatus[s] = (byStatus[s] || 0) + 1;
      if (r.failed || r.status >= 400) failed += 1;
    }
    out.summary = { totalRequests: ctx.network.length, failed, byCategory, byStatus };
  }

  // ---- DevTools · Application ----
  if (spec.cookies) out.cookies = await page.context().cookies();
  if (spec.storage) {
    out.storage = await page.evaluate(async () => {
      const dump = (s) => { const o = {}; for (let i = 0; i < s.length; i++) { const k = s.key(i); o[k] = s.getItem(k); } return o; };
      let indexedDB_dbs = [];
      try { if (window.indexedDB && indexedDB.databases) indexedDB_dbs = (await indexedDB.databases()).map((d) => ({ name: d.name, version: d.version })); } catch (e) {}
      return { localStorage: dump(window.localStorage), sessionStorage: dump(window.sessionStorage), indexedDB: indexedDB_dbs };
    });
  }

  // ---- DevTools · Performance ----
  if (spec.perf || spec.resources) {
    const p = await page.evaluate(() => {
      const round = (n) => (n == null ? null : Math.round(n));
      const nav = performance.getEntriesByType('navigation')[0];
      const navigation = nav ? {
        ttfbMs: round(nav.responseStart), domInteractiveMs: round(nav.domInteractive),
        domContentLoadedMs: round(nav.domContentLoadedEventEnd), loadMs: round(nav.loadEventEnd),
        transferSize: nav.transferSize, encodedBodySize: nav.encodedBodySize, decodedBodySize: nav.decodedBodySize,
      } : null;
      const paints = performance.getEntriesByType('paint').map((x) => ({ name: x.name, startMs: round(x.startTime) }));
      const resources = performance.getEntriesByType('resource').map((r) => ({
        name: r.name, type: r.initiatorType, startMs: round(r.startTime), durationMs: round(r.duration),
        transferSize: r.transferSize, encodedBodySize: r.encodedBodySize, decodedBodySize: r.decodedBodySize,
      }));
      return { navigation, paints, resources };
    });
    if (spec.perf) out.perf = { navigation: p.navigation, paints: p.paints };
    if (spec.resources) out.resources = p.resources;
  }
  if (spec.webVitals) {
    out.webVitals = await page.evaluate(() => new Promise((resolve) => {
      const r = (n) => (n == null ? null : Math.round(n));
      const nav = performance.getEntriesByType('navigation')[0];
      const v = { ttfb: nav ? r(nav.responseStart) : null, fcp: null, lcp: null, cls: 0, inp: null };
      const fcp = performance.getEntriesByType('paint').find((p) => p.name === 'first-contentful-paint');
      if (fcp) v.fcp = r(fcp.startTime);
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) v.lcp = r(e.startTime); }).observe({ type: 'largest-contentful-paint', buffered: true }); } catch (e) {}
      try { new PerformanceObserver((l) => { for (const e of l.getEntries()) { if (!e.hadRecentInput) v.cls += e.value; } }).observe({ type: 'layout-shift', buffered: true }); } catch (e) {}
      setTimeout(() => { v.cls = Math.round(v.cls * 1000) / 1000; resolve(v); }, 300);
    }));
  }
  if (spec.metrics) {
    await cdp.send('Performance.enable').catch(() => {});
    out.metrics = (await cdp.send('Performance.getMetrics')).metrics;
  }
  if (spec.coverage) {
    const js = await page.coverage.stopJSCoverage().catch(() => []);
    const css = await page.coverage.stopCSSCoverage().catch(() => []);
    const cssFiles = css.map((e) => { const total = e.text ? e.text.length : 0; const used = unionLen((e.ranges || []).map((x) => [x.start, x.end])); return { url: e.url, totalBytes: total, usedBytes: used, unusedBytes: total - used }; });
    const jsFiles = js.map((e) => {
      // block coverage nests; a byte is unused only if a count===0 (never-run) range covers it
      const total = e.source ? e.source.length : 0; const uncov = [];
      for (const f of (e.functions || [])) for (const x of f.ranges) if (x.count === 0) uncov.push([x.startOffset, x.endOffset]);
      const unused = Math.min(unionLen(uncov), total); return { url: e.url, totalBytes: total, usedBytes: total - unused, unusedBytes: unused };
    });
    out.coverage = { css: rollup(cssFiles), js: rollup(jsFiles) };
  }

  // ---- DevTools · Accessibility ----
  if (spec.axTree) {
    await cdp.send('Accessibility.enable').catch(() => {});
    out.axTree = (await cdp.send('Accessibility.getFullAXTree')).nodes;
  }

  // ---- markup ----
  if (spec.html) out.html = await page.content();
  if (Array.isArray(spec.snippets) && spec.snippets.length) {
    out.snippets = await page.evaluate((sels) => sels.map((sel) => {
      try { const el = document.querySelector(sel); return { selector: sel, found: !!el, html: el ? el.outerHTML : null }; }
      catch (e) { return { selector: sel, found: false, error: String(e) }; }
    }), spec.snippets);
  }

  // ---- DOM ----
  if (spec.seo) {
    out.seo = await page.evaluate(() => {
      const c = (s) => { const e = document.querySelector(s); return e ? (e.getAttribute('content') || e.textContent || null) : null; };
      const href = (s) => { const e = document.querySelector(s); return e ? e.href : null; };
      return {
        title: document.title || null, description: c('meta[name="description"]'), canonical: href('link[rel="canonical"]'),
        robots: c('meta[name="robots"]'), viewport: c('meta[name="viewport"]'), lang: document.documentElement.lang || null,
        h1: [...document.querySelectorAll('h1')].map((h) => h.textContent.trim()),
        og: { title: c('meta[property="og:title"]'), description: c('meta[property="og:description"]'), image: c('meta[property="og:image"]'), url: c('meta[property="og:url"]'), type: c('meta[property="og:type"]') },
      };
    });
  }
  if (spec.domStats) {
    out.domStats = await page.evaluate(() => {
      let depth = 0; const walk = (el, d) => { if (d > depth) depth = d; for (const ch of el.children) walk(ch, d + 1); };
      walk(document.documentElement, 1);
      return { nodes: document.getElementsByTagName('*').length, maxDepth: depth, htmlBytes: document.documentElement.outerHTML.length };
    });
  }
  if (spec.brokenImages) {
    out.brokenImages = await page.evaluate(() => [...document.images].filter((i) => i.complete && i.naturalWidth === 0).map((i) => ({ src: i.currentSrc || i.src, alt: i.alt || null })));
  }

  // ---- escape hatch: raw Chrome DevTools Protocol (full DevTools) ----
  if (spec.cdp) {
    const calls = Array.isArray(spec.cdp) ? spec.cdp : [spec.cdp];
    out.cdp = [];
    for (const c of calls) {
      try { out.cdp.push({ method: c.method, result: await cdp.send(c.method, c.params || {}) }); }
      catch (e) { out.cdp.push({ method: c.method, error: String((e && e.message) || e) }); }
    }
  }

  return out;
}
