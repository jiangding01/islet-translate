// Gzip size budget for the production build. Zero dependencies on purpose.
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';

const KB = 1024;
const output = resolve('.output/chrome-mv3');
const manifest = JSON.parse(await readFile(resolve(output, 'manifest.json'), 'utf8'));

/** Paths in HTML are absolute to the extension root ("/chunks/x.js"). */
const toOutputPath = (file) => resolve(output, file.replace(/^\//, ''));

async function gzipSize(file) {
  return gzipSync(await readFile(toOutputPath(file))).length;
}

/** All JS a page loads: entry scripts plus modulepreloaded shared chunks. */
async function pageScripts(htmlFile) {
  const html = await readFile(toOutputPath(htmlFile), 'utf8');
  const files = new Set();
  for (const tag of html.match(/<(?:script|link)\b[^>]*>/g) ?? []) {
    const isScript = tag.startsWith('<script');
    const isPreload = /\brel=["']?modulepreload\b/.test(tag);
    const url = tag.match(isScript ? /\bsrc=["']?([^"'\s>]+)/ : /\bhref=["']?([^"'\s>]+)/)?.[1];
    if (url && (isScript || isPreload) && url.endsWith('.js')) files.add(url);
  }
  return [...files];
}

// The on-demand modules are the manifest's web accessible resources, each with its own budget.
const resourceFiles = (manifest.web_accessible_resources ?? []).flatMap((entry) => entry.resources);
const runtimeFiles = (name) => resourceFiles.filter((file) => file === `${name}.js`);

const entries = [
  {
    name: 'content',
    // First-screen bootstrap and selection watcher; the session and the card live in the
    // on-demand modules below. Raised from 6KB in M3a (selection watch, approved).
    // Raised to 7.5KB (2026-11-20, user approved, M3b plan): the hold-to-toggle watch.
    // Raised to 7.75KB (2026-11-23, user approved, M3c plan): the palette loader, the page
    // action table, the card/palette exclusion and the hold watch's own-host check.
    budget: 7.75 * KB,
    files: manifest.content_scripts?.flatMap((script) => script.js ?? []) ?? [],
  },
  {
    name: 'page-runtime',
    // Session, scanner, renderer and the page isle (M2b PR2). Tightened from 26KB in M3a:
    // the full error copy table left the content bundles (the background now attaches
    // `userMessage`), so the old headroom would hide it creeping back. Raise explicitly,
    // never quietly. Raised to 25KB (2026-11-19, user approved, pre-release polish) when the
    // status-note layout rule (one line, not squeezed in a flex box) took it to 24.03KB.
    // Raised to 27KB (2026-11-20, user approved, M3b plan): the auto-start language check
    // moved here from the content script, then the in-page shortcuts follow.
    // Raised to 28KB (2026-11-23, user approved, M3c plan): the isle's Escape yields to the
    // palette (PR1), then region translate/exclude and the isle's palette entry (PR4–PR6).
    budget: 28 * KB,
    files: runtimeFiles('page-runtime'),
  },
  {
    name: 'selection-runtime',
    // The selection dot and card (M3a). Planned at 16KB; raised to 18KB after the M3a build
    // measured 16.87KB, with the user's approval; raised to 19KB (2026-11-17, user approved)
    // when UK/US phonetics took it to 18.02KB. Raise explicitly, never quietly.
    budget: 19 * KB,
    files: runtimeFiles('selection-runtime'),
  },
  {
    name: 'palette-runtime',
    // The command palette (M3c). Budget 15KB (2026-11-23, user approved, M3c plan): about
    // 8KB in PR1, then quick translate (PR3) and the region picker (PR4). Raised to 18KB
    // (2026-11-24, user approved) after PR3 measured 14.26KB; in effect from PR4 (the region
    // picker). Raise explicitly, never quietly.
    budget: 18 * KB,
    files: runtimeFiles('palette-runtime'),
  },
  {
    name: 'background',
    // Raised to 66KB (2026-11-26, user approved, M4 plan docs/plans/m4.md), in effect from
    // M4-A (thinking rules and extra request body).
    budget: 66 * KB,
    files: manifest.background?.service_worker ? [manifest.background.service_worker] : [],
  },
  {
    name: 'popup',
    // Raised from 80KB in M1 3b: React DOM (~60KB) is a fixed cost and the panel now
    // shares the settings page's select and engine view. Past 90KB, evaluate a lighter
    // runtime before raising again.
    budget: 90 * KB,
    files: manifest.action?.default_popup ? await pageScripts(manifest.action.default_popup) : [],
  },
  {
    name: 'options',
    budget: 150 * KB,
    files: manifest.options_ui?.page ? await pageScripts(manifest.options_ui.page) : [],
  },
];

let failed = false;
const rows = [];
for (const entry of entries) {
  if (entry.files.length === 0) {
    failed = true;
    rows.push({ entry: entry.name, gzip: '-', budget: entry.budget, status: 'MISSING' });
    continue;
  }
  const sizes = await Promise.all(entry.files.map(gzipSize));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const ok = total <= entry.budget;
  if (!ok) failed = true;
  rows.push({ entry: entry.name, gzip: total, budget: entry.budget, status: ok ? 'ok' : 'OVER' });
  entry.files.forEach((file, index) => {
    console.log(
      `  ${entry.name.padEnd(12)} ${(sizes[index] / KB).toFixed(2).padStart(8)} KB  ${file}`,
    );
  });
}

// Not JS: the phonetic table shards (scripts/build-phonetics.mjs), fetched by the background
// one at a time as words need them. Each shard has its own budget, and so does each accent's
// whole table (v4 measured about 1.39MB British and 0.78MB American).
const SHARD_BUDGET = 40 * KB;
const TABLE_BUDGET = 2048 * KB;
for (const [name, dir] of [
  ['phonetic-gb', 'dict/gb'],
  ['phonetic-us', 'dict/us'],
]) {
  let shards = [];
  try {
    shards = (await readdir(resolve(output, dir))).filter((file) => file.endsWith('.tsv'));
  } catch {
    // Reported as missing below.
  }
  if (shards.length === 0) {
    failed = true;
    rows.push({ entry: name, gzip: '-', budget: TABLE_BUDGET, status: 'MISSING' });
    continue;
  }
  const sizes = await Promise.all(shards.map((file) => gzipSize(`${dir}/${file}`)));
  const total = sizes.reduce((sum, size) => sum + size, 0);
  const largest = Math.max(...sizes);
  const over = shards.filter((_file, index) => (sizes[index] ?? 0) > SHARD_BUDGET);
  for (const file of over) console.log(`  ${name.padEnd(12)} shard over budget: ${dir}/${file}`);
  console.log(
    `  ${name.padEnd(12)} ${shards.length} shards, largest ${(largest / KB).toFixed(2)} KB`,
  );
  const ok = total <= TABLE_BUDGET && over.length === 0;
  if (!ok) failed = true;
  rows.push({ entry: name, gzip: total, budget: TABLE_BUDGET, status: ok ? 'ok' : 'OVER' });
  rows.push({
    entry: `${name} max`,
    gzip: largest,
    budget: SHARD_BUDGET,
    status: over.length === 0 ? 'ok' : 'OVER',
  });
}

const format = (value) => (typeof value === 'number' ? `${(value / KB).toFixed(2)} KB` : value);
console.log('\nentry        gzip         budget       status');
for (const row of rows) {
  console.log(
    `${row.entry.padEnd(13)} ${format(row.gzip).padEnd(12)} ${format(row.budget).padEnd(12)} ${row.status}`,
  );
}

if (failed) {
  console.error('\nSize check failed: an entry is over budget or its files could not be found.');
  process.exit(1);
}
console.log('\nSize check passed.');
