// executor.js — runs the `commands` list: the ACTIONS to perform on the page.
// (DevTools DATA to capture lives in collect.js, driven by the `returns` spec.)
import path from 'node:path';

/** Run every command in order; never throws — failures become { ok:false } entries. */
export async function runCommands(page, commands, ctx) {
  const results = [];
  for (const cmd of commands) {
    try {
      results.push({ i: cmd._i, action: cmd.action, ok: true, ...(await handle(page, cmd, ctx)) });
    } catch (err) {
      results.push({ i: cmd._i, action: cmd.action, ok: false, error: msg(err) });
    }
  }
  return results;
}

const msg = (e) => String((e && e.message) || e);
const safe = (s) => String(s || '').replace(/[^\w.-]/g, '_');

async function handle(page, cmd, ctx) {
  switch (cmd.action) {
    case 'goto': {
      const res = await page.goto(cmd.url || ctx.url, { waitUntil: cmd.waitUntil || 'load', timeout: cmd.timeout || ctx.timeout });
      return { status: res ? res.status() : null, url: page.url() };
    }
    case 'waitFor': {
      if (cmd.selector) {
        await page.waitForSelector(cmd.selector, { state: cmd.state || 'visible', timeout: cmd.timeout || ctx.timeout });
        return { selector: cmd.selector };
      }
      await page.waitForTimeout(cmd.timeout || 1000);
      return { waited: cmd.timeout || 1000 };
    }
    case 'click':
      await page.click(cmd.selector, { timeout: cmd.timeout || ctx.timeout });
      return { selector: cmd.selector };
    case 'fill':
    case 'type':
      await page.fill(cmd.selector, cmd.text ?? '', { timeout: cmd.timeout || ctx.timeout });
      return { selector: cmd.selector };
    case 'select': {
      // cmd.value: a string, or an array of strings, matched against option value (then label)
      const values = await page.selectOption(cmd.selector, cmd.value, { timeout: cmd.timeout || ctx.timeout });
      return { selector: cmd.selector, values };
    }
    case 'check':
      await page.check(cmd.selector, { timeout: cmd.timeout || ctx.timeout });
      return { selector: cmd.selector };
    case 'uncheck':
      await page.uncheck(cmd.selector, { timeout: cmd.timeout || ctx.timeout });
      return { selector: cmd.selector };
    case 'press':
      await page.press(cmd.selector, cmd.key, { timeout: cmd.timeout || ctx.timeout });
      return { selector: cmd.selector, key: cmd.key };
    case 'hover':
      await page.hover(cmd.selector, { timeout: cmd.timeout || ctx.timeout });
      return { selector: cmd.selector };
    case 'scroll': {
      if (cmd.selector) {
        await page.locator(cmd.selector).scrollIntoViewIfNeeded({ timeout: cmd.timeout || ctx.timeout });
        return { selector: cmd.selector };
      }
      const x = cmd.x || 0, y = cmd.y || 0;
      await page.evaluate(([dx, dy]) => window.scrollBy(dx, dy), [x, y]);
      return { x, y };
    }
    case 'screenshot': {
      const file = path.join(ctx.jobDir, `${safe(cmd.name || `shot-${cmd._i}`)}.png`);
      if (cmd.selector) {
        const el = await page.waitForSelector(cmd.selector, { timeout: cmd.timeout || ctx.timeout });
        await el.screenshot({ path: file });
      } else {
        await page.screenshot({ path: file, fullPage: cmd.fullPage !== false });
      }
      return { path: file };
    }
    case 'evaluate': {
      // arbitrary caller JS, run in the page context (not the host)
      const value = await page.evaluate(`(async () => { ${cmd.script} })()`);
      return { value };
    }
    case 'pdf': {
      const file = path.join(ctx.jobDir, `${safe(cmd.name || 'page')}.pdf`);
      await page.pdf({ path: file });
      return { path: file };
    }
    default:
      throw new Error(`unknown action: ${cmd.action}`);
  }
}
