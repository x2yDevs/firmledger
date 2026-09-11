/**
 * Focus hygiene — no input, dropdown or textarea may ever show an overlaying
 * ring (outline, glow or shadow) when selected or during input.
 * npm run test:focus
 *
 * The site has ONE stylesheet (public/css/app.css) and no inline/JS-injected
 * focus styles, so the guarantee is enforced statically:
 *   1. No rule that targets a form field may set a visible outline or
 *      box-shadow in any state — `none` is the only legal value.
 *   2. The end-of-file guard block exists and wins (!important) for every
 *      focus state (:focus, :focus-visible, :active) on every field.
 *   3. Every <select> site-wide gets the custom-chevron, no-OS-chrome
 *      treatment (appearance:none), so no dropdown falls back to native
 *      browser focus UI.
 *   4. The translucent mobile tap highlight is disabled, and Chrome's pale
 *      blue autofill wash is held back to the design surface.
 *   5. No view declares its own focus styling (inline style attributes or
 *      <style> blocks) that could bypass the stylesheet.
 */
const assert = require('assert/strict');
const fs = require('fs');
const path = require('path');

const cssPath = path.join(__dirname, '..', 'public', 'css', 'app.css');
const css = fs.readFileSync(cssPath, 'utf8');

let passed = 0;
function check(label, ok, extra = '') {
  if (ok) { passed++; console.log(`  ✓ ${label}`); return; }
  console.error(`  ✗ ${label}${extra ? ' — ' + extra : ''}`);
  process.exitCode = 1;
}

/* ---------- tiny CSS splitter: rules, @media nesting, top-level commas ---------- */
function stripComments(src) { return src.replace(/\/\*[\s\S]*?\*\//g, ''); }
function splitTop(src, sep) {
  const out = []; let depth = 0, cur = '', str = null;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (str) { cur += c; if (c === str && src[i - 1] !== '\\') str = null; continue; }
    if (c === '"' || c === "'") { str = c; cur += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (c === sep && depth === 0) { out.push(cur); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) out.push(cur);
  return out;
}
function parseRules(src) {
  const rules = [];
  let i = 0;
  while (i < src.length) {
    const brace = src.indexOf('{', i);
    if (brace === -1) break;
    const pre = src.slice(i, brace).trim();
    // find matching close brace
    let depth = 0, j = brace;
    for (; j < src.length; j++) {
      if (src[j] === '{') depth++;
      else if (src[j] === '}') { depth--; if (depth === 0) break; }
    }
    const body = src.slice(brace + 1, j);
    if (pre.startsWith('@media') || pre.startsWith('@supports')) {
      rules.push(...parseRules(body));
    } else if (!pre.startsWith('@')) {
      const decls = {};
      for (const d of splitTop(body, ';')) {
        const m = d.trim().match(/^([-\w]+)\s*:\s*(.+)$/s);
        if (m) decls[m[1].toLowerCase().trim()] = m[2].trim().replace(/\s+/g, ' ');
      }
      for (const sel of splitTop(pre, ',')) rules.push({ selector: sel.trim(), decls });
    }
    i = j + 1;
  }
  return rules;
}

const rules = parseRules(stripComments(css));
check('stylesheet parses into rules', rules.length > 200, `got ${rules.length}`);

/* ---------- which rules target a form field as their subject? ---------- */
/* Subject = the last compound selector. A compound targets a field when it is,
   or starts with, input/select/textarea (with any functions attached). */
function subjectOf(sel) {
  const parts = splitTop(sel.replace(/::?(before|after|placeholder|selection|-ms-expand|-webkit\w+)/g, (m) => m.replace(/[^\w-]/g, '')), ' ')
    .filter((p) => !['>', '+', '~'].includes(p));
  return (parts[parts.length - 1] || '').trim();
}
function targetsField(sel) {
  const s = subjectOf(sel);
  return /^(input|select|textarea)([:\[]|$)/.test(s)
    || /^:where\((input|select|textarea)\b/.test(s)
    || /^:is\((input|select|textarea)\b/.test(s);
}

const ringProps = ['outline', 'outline-color', 'outline-style', 'outline-width', 'box-shadow', '-webkit-box-shadow'];
const AUTOFILL_HOLD = '0 0 0 1000px var(--surface) inset'; /* invisible: surface under the autofill wash */
const isNone = (v) => {
  const t = v.toLowerCase().replace(/\s*!important\s*$/i, '').replace(/\s+/g, ' ').trim();
  return t === 'none' || t === '0' || t === 'transparent' || t === 'initial' || t === 'unset'
    || t === 'revert' || t === 'normal' || t === AUTOFILL_HOLD;
};
const offenders = [];
for (const r of rules) {
  if (!targetsField(r.selector)) continue;
  for (const p of ringProps) {
    if (p in r.decls && !isNone(r.decls[p])) offenders.push(`${r.selector} { ${p}: ${r.decls[p]} }`);
  }
}
check('no form-field rule paints an outline or shadow ring', offenders.length === 0,
  offenders.slice(0, 8).join(' | '));

/* ---------- the guard block: !important none on every focus state ---------- */
const focusGuard = rules.filter((r) =>
  targetsField(r.selector) && /:focus/.test(r.selector)
  && r.decls['outline'] && r.decls['outline'].includes('!important')
  && r.decls['box-shadow'] && r.decls['box-shadow'].includes('!important'));
check('focus guard block present (!important outline/box-shadow none on fields)', focusGuard.length >= 1);
check('guard covers :focus-visible and :active too',
  /select:is\(:focus,\s*:focus-visible,\s*:active\)/.test(css));

/* ---------- every select loses the OS widget ---------- */
const selectBaseline = rules.filter((r) =>
  /^select(?::not\(:where\(.chat-model-pick select\)\))?$/.test(r.selector)
  && r.decls['appearance'] === 'none');
check('global select baseline: appearance:none + custom chevron site-wide',
  selectBaseline.some((r) => r.decls['background-image'] && r.decls['padding-right']));

/* ---------- dark console select keeps its own white chevron ---------- */
const darkPick = rules.filter((r) => /^\.chat-model-pick select(:hover)?$/.test(r.selector) && r.decls['background']);
check('dark AI console picker keeps its own chevron', darkPick.length >= 1);

/* ---------- tap highlight + autofill wash ---------- */
check('translucent mobile tap highlight disabled', /html\s*{[^}]*-webkit-tap-highlight-color:\s*transparent/.test(stripComments(css)));
const autofill = rules.filter((r) => /autofill/.test(r.selector) && r.decls['-webkit-box-shadow'] === '0 0 0 1000px var(--surface) inset !important');
check('Chrome autofill blue wash held to the surface color', autofill.length >= 1);

/* ---------- existing single-indicator design rules still in place ---------- */
check('text-like input baseline still kills outline/shadow',
  /input:where\(:not\(\[type="checkbox"\]\)[^{]*textarea:where\(:not\(\[data-raw\]\)\)\s*{[^}]*outline:\s*none[^}]*box-shadow:\s*none/.test(css));
check('select:focus still outline:none (all selects)',
  /select:focus\s*{[^}]*outline:\s*none/.test(css));

/* ---------- no view bypasses the stylesheet ---------- */
const viewsDir = path.join(__dirname, '..', 'views');
const bypass = [];
const walk = (dir) => {
  for (const f of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, f.name);
    if (f.isDirectory()) walk(p);
    else if (f.name.endsWith('.ejs')) {
      const src = fs.readFileSync(p, 'utf8');
      if (/<style[\s>]/.test(src)) bypass.push(`${p}: <style> block`);
      for (const m of src.matchAll(/<(?:input|select|textarea)\b[^>]*style="([^"]*)"/g)) {
        if (/outline|box-shadow|tap-highlight/i.test(m[1])) bypass.push(`${p}: ${m[1]}`);
      }
    }
  }
};
walk(viewsDir);
check('no view declares its own focus/ring styling', bypass.length === 0, bypass.join(' | '));

/* ---------- the script that ships to browsers injects no focus styles ---------- */
for (const js of ['main.js', 'graph.js']) {
  const src = fs.readFileSync(path.join(__dirname, '..', 'public', 'js', js), 'utf8');
  check(`${js} injects no outline/box-shadow focus styling`,
    !/(outline|boxShadow)\s*[:=]\s*['"]?(?!none)/.test(src.replace(/none/g, 'none')) || !/(style\.outline|style\.boxShadow)/.test(src));
}

console.log(`\nFocus hygiene: ${passed} checks ${process.exitCode ? 'FAIL' : 'passed'}`);
