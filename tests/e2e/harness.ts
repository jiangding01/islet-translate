// Smoke e2e harness: the built extension in a headless Chrome for Testing, driven over raw
// CDP (no dependencies). One browser-level WebSocket with flattened sessions: new pages and
// our service worker are auto-attached paused, set up, then resumed; a restarted worker keeps
// its session but starts paused again, so it is re-armed (Fetch) and resumed on every new
// context. Pages are intercepted as well, so no request leaves unmocked and unlisted.
// Plan: docs/plans/e2e-smoke.md.

import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeEach } from 'vitest';
import { findChrome } from '../../scripts/lib/find-chrome.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const BUILD = join(ROOT, '.output/chrome-mv3');
const FIXTURES = join(ROOT, 'tests/fixtures');
const RESULTS = join(ROOT, 'test-results/e2e');
const GOOGLE = 'https://translate.googleapis.com/';
/** Requests the worker may make for real: its own files and the fixture server. */
const LOCAL = /^(chrome-extension:|http:\/\/127\.0\.0\.1[:/])/;
const FLAGS = [
  '--headless=new --remote-debugging-port=0 --no-first-run --no-default-browser-check',
  '--use-mock-keychain --password-store=basic --disable-background-networking',
  '--disable-component-update --hide-scrollbars --window-size=1280,800',
]
  .join(' ')
  .split(' ');

export type UiLocale = 'en' | 'zh_CN' | 'zh_TW';
export interface LaunchOptions {
  /** Keep only this `_locales` folder and make it the default: forces the interface language. */
  ui?: UiLocale;
  /** Browser `--lang` (Chrome honours it on Linux only). */
  lang?: string;
  /** Load an unchanged copy of the build (pair with `lang`); `ui` is ignored. */
  raw?: boolean;
}

/**
 * Per text: a translation, an HTTP status for the whole request, or undefined for the default.
 * May return a promise: the request then waits (a slow service) until it settles. The second
 * argument tells the endpoint apart: `html` for POST /t with format=html, `single` for GET /single.
 */
type GoogleReply = string | number | undefined;
export type GoogleHandler = (
  text: string,
  request: { html: boolean; single: boolean },
) => GoogleReply | Promise<GoogleReply>;
type Point = { x: number; y: number };
// biome-ignore lint/suspicious/noExplicitAny: CDP payloads are untyped JSON
type Json = Record<string, any>;

export interface ExtPageOptions {
  /** Script run in the page before any of its own (Page.addScriptToEvaluateOnNewDocument). */
  preload?: string;
}

export interface ExtPage {
  evaluate<T = unknown>(expression: string): Promise<T>;
  /** runtime.sendMessage in webext-core format; resolves to the handler's Result. */
  send<T = unknown>(type: string, data?: unknown): Promise<T>;
  close(): Promise<void>;
}

export interface Harness {
  extensionId: string;
  /** The id of the test page's tab. */
  tabId: number;
  /** Google requests seen (POST /t and GET /single) and every `q` they carried. */
  google: { count: number; texts: string[] };
  /** Replaces the Google handler; no argument restores the default. */
  mockGoogle(handler?: GoogleHandler): void;
  /** Clears errors, unmocked requests, the worker log and the Google counters. */
  resetLogs(): void;
  /** Loads tests/fixtures/<fixture> in the test tab (a new document even for the same URL). */
  openPage(fixture: string): Promise<void>;
  /** Evaluates in the test page's main world (awaits promises, returns by value). */
  evaluate<T = unknown>(expression: string): Promise<T>;
  /**
   * Evaluates in the extension's content-script world of the test page's top frame (the
   * isolated world: page scripts cannot see what is changed there). Waits for that world to
   * exist, as the content script is injected after the page loads.
   */
  evalInContentWorld<T = unknown>(expression: string): Promise<T>;
  /** Overrides the test page's viewport size (CDP device metrics) until clearViewport(). */
  setViewport(width: number, height: number): Promise<void>;
  clearViewport(): Promise<void>;
  /** Evaluates in the extension service worker. */
  sw<T = unknown>(expression: string): Promise<T>;
  /** tabs.sendMessage to the test page's top frame; resolves to the handler's Result. */
  tell<T = unknown>(type: string, data?: unknown): Promise<T>;
  /** Opens an extension page (e.g. options.html) in its own window. */
  extPage(path: string, options?: ExtPageOptions): Promise<ExtPage>;
  /** Waits for a page the browser opened itself (e.g. the popup) and attaches to it. */
  waitForExtPage(path: string): Promise<ExtPage>;
  /**
   * Runs `fn` (a function expression, given the shadow root) on the shadow root of the first
   * element with this tag name in the test page, closed roots included.
   */
  shadow<T = unknown>(tagName: string, fn: string): Promise<T>;
  /** Stops the worker; the next event restarts it, interception included. */
  stopServiceWorker(): Promise<void>;
  /**
   * Reloads the extension, as an update would: pages already open keep their old content
   * scripts, now cut off from the extension; the new worker is armed when this resolves.
   * Close extension pages first (the reload replaces them with a new tab), and do not `tell`
   * an old page afterwards (it never answers); look at its DOM instead.
   */
  reloadExtension(): Promise<void>;
  /** A trusted click (CDP input) at a selector's centre or at viewport coordinates. */
  trustedClick(target: string | Point): Promise<void>;
  /**
   * A raw trusted input event (CDP `Input.dispatchKeyEvent` / `Input.dispatchMouseEvent`), or
   * text committed as an input method would (`Input.insertText`).
   */
  input(
    method: 'Input.dispatchKeyEvent' | 'Input.dispatchMouseEvent' | 'Input.insertText',
    params: Json,
  ): Promise<void>;
  errors: string[];
  unmocked: string[];
  assertNoErrors(): void;
  saveArtifacts(name: string): Promise<void>;
  close(): Promise<void>;
}

const sleep = (ms: number) => new Promise((done) => setTimeout(done, ms));

type Truthy<T> = Exclude<T, null | undefined | false | 0 | ''>;

/** Polls until `fn` returns a truthy value (and resolves to it); errors count as "not yet". */
export async function waitFor<T>(
  fn: () => T | Promise<T>,
  { timeout = 10_000, interval = 100, message = 'condition' } = {},
): Promise<Truthy<T>> {
  const end = Date.now() + timeout;
  for (;;) {
    let last: unknown;
    try {
      last = await fn();
      if (last) return last as Truthy<T>;
    } catch (error) {
      last = error;
    }
    if (Date.now() > end) {
      const detail = last instanceof Error ? last.message : JSON.stringify(last);
      throw new Error(`timed out after ${timeout}ms waiting for ${message} (last: ${detail})`);
    }
    await sleep(interval);
  }
}

/**
 * The default mock translation: "【MOCK】" plus the source with Latin letters upper-cased.
 * Not the verbatim source: a reply containing a source sentence counts as an echo
 * (src/lib/translate/echo.ts), is retried on /single and never cached. Inline tags and
 * entities are kept, so links and code survive.
 */
export function mockTranslate(text: string): string {
  return `【MOCK】${text.replace(/(<[^>]*>|&#?\w+;)|[a-z]+/g, (m, keep) => keep ?? m.toUpperCase())}`;
}

/** Chrome's id for an unpacked extension: SHA-256 of its real path, hex digits mapped to a-p. */
function extensionIdFor(dir: string): string {
  const hex = createHash('sha256').update(realpathSync(dir)).digest('hex').slice(0, 32);
  return [...hex].map((c) => String.fromCharCode(97 + Number.parseInt(c, 16))).join('');
}

function copyBuild(dir: string, ui: UiLocale | undefined) {
  if (!existsSync(join(BUILD, 'manifest.json'))) {
    throw new Error(`no build at ${BUILD}; run npm run build first`);
  }
  cpSync(BUILD, dir, { recursive: true });
  if (!ui) return;
  const locales = join(dir, '_locales');
  if (!existsSync(join(locales, ui))) throw new Error(`the build has no _locales/${ui}`);
  for (const locale of readdirSync(locales)) {
    if (locale !== ui) rmSync(join(locales, locale), { recursive: true });
  }
  const manifest = JSON.parse(readFileSync(join(dir, 'manifest.json'), 'utf8'));
  manifest.default_locale = ui;
  writeFileSync(join(dir, 'manifest.json'), JSON.stringify(manifest));
}

type Listener = (method: string, params: Json, sessionId?: string) => void;

async function connect(url: string) {
  const ws = new WebSocket(url);
  await new Promise((done, reject) => {
    ws.onopen = done;
    ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
  });
  let next = 0;
  const waiting = new Map<number, (message: Json) => void>();
  const listeners: Listener[] = [];
  ws.onmessage = (event) => {
    const message = JSON.parse(String(event.data));
    if (typeof message.id !== 'number') {
      for (const listen of listeners) listen(message.method, message.params, message.sessionId);
      return;
    }
    const reply = waiting.get(message.id);
    if (typeof reply === 'function') reply(message);
  };
  ws.onclose = () => {
    for (const settle of waiting.values()) settle({ error: { message: 'CDP connection closed' } });
  };
  const send = (method: string, params: Json = {}, sessionId?: string) =>
    new Promise<Json>((done, fail) => {
      if (ws.readyState !== WebSocket.OPEN) throw new Error('CDP connection closed');
      const id = ++next;
      const timer = setTimeout(() => settle({ error: { message: 'timed out' } }), 15_000);
      const settle = (message: Json) => {
        clearTimeout(timer);
        waiting.delete(id);
        if (message.error) fail(new Error(`CDP ${method}: ${message.error.message}`));
        else done(message.result ?? {});
      };
      waiting.set(id, settle);
      ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  return { send, on: (listen: Listener) => listeners.push(listen), close: () => ws.close() };
}

/** Starts a browser with a copy of the build. On failure everything started is cleaned up. */
export async function launch(options: LaunchOptions = {}): Promise<Harness> {
  const cleanup: (() => unknown)[] = [];
  const close = async () => {
    // Each step on its own: a step that throws (even synchronously) must not skip the rest.
    for (const step of cleanup.splice(0).reverse()) {
      try {
        await step();
      } catch {}
    }
  };
  try {
    return await start(options, cleanup, close);
  } catch (error) {
    await close();
    throw error;
  }
}

async function start(
  options: LaunchOptions,
  cleanup: (() => unknown)[],
  close: () => Promise<void>,
): Promise<Harness> {
  const chromePath = findChrome();
  const tempDir = (prefix: string) => {
    const dir = mkdtempSync(join(tmpdir(), prefix));
    cleanup.push(() => rmSync(dir, { recursive: true, force: true }));
    return dir;
  };
  const extDir = tempDir('et-e2e-ext-');
  copyBuild(extDir, options.raw ? undefined : (options.ui ?? 'en'));
  const extensionId = extensionIdFor(extDir);
  const profileDir = tempDir('et-e2e-profile-');

  // Fixtures (flat, .html only); a silent favicon keeps the console clean.
  const server = createServer((req, res) => {
    const name = /^\/([\w-]+\.html)(?:\?.*)?$/.exec(req.url ?? '')?.[1];
    const file = name ? join(FIXTURES, name) : '';
    if (!file || !existsSync(file)) res.writeHead(req.url === '/favicon.ico' ? 204 : 404).end();
    else res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' }).end(readFileSync(file));
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  cleanup.push(() => new Promise((done) => server.close(done)));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;

  const args = [
    `--user-data-dir=${profileDir}`,
    `--load-extension=${extDir}`,
    `--disable-extensions-except=${extDir}`,
    ...FLAGS,
    // Second line of defence: nothing but the fixture server resolves.
    '--host-resolver-rules=MAP * ~NOTFOUND, EXCLUDE 127.0.0.1',
  ];
  // Linux builds may take the interface language from the environment instead of --lang.
  const env = options.lang
    ? { ...process.env, LANGUAGE: options.lang.replace('-', '_') }
    : process.env;
  if (options.lang) args.push(`--lang=${options.lang}`);
  if (process.platform === 'linux' || process.env.CI) args.push('--no-sandbox');
  const chrome = spawn(chromePath, [...args, 'about:blank'], { stdio: 'ignore', env });
  let exited: string | undefined;
  chrome.once('error', (error) => {
    exited = error.message;
  });
  chrome.once('exit', (code) => {
    exited ??= `exit code ${code}`;
  });
  cleanup.push(async () => {
    if (exited) return;
    const gone = new Promise((done) => chrome.once('exit', () => done(true)));
    chrome.kill('SIGTERM');
    if (await Promise.race([gone, sleep(5000)])) return;
    // Wait for the kill too, so the profile is not removed under a live browser.
    chrome.kill('SIGKILL');
    await Promise.race([gone, sleep(5000)]);
  });

  // DevTools writes its port and browser path here once it listens.
  const portFile = join(profileDir, 'DevToolsActivePort');
  const [rawPort = '', rawPath = ''] = await waitFor(
    () => {
      if (exited) throw new Error(`the browser did not start: ${exited}`);
      const lines = existsSync(portFile) ? readFileSync(portFile, 'utf8').split('\n') : [];
      return lines[1] ? lines : undefined;
    },
    { timeout: 20_000, message: 'DevToolsActivePort' },
  );
  // Chrome writes this file itself and we only ever connect to localhost, but validate
  // strictly so file content can never steer the URL somewhere else.
  const port = /^\d{1,5}$/.test(rawPort) ? Number.parseInt(rawPort, 10) : 0;
  if (port < 1 || port > 65535) throw new Error(`invalid port in DevToolsActivePort: ${rawPort}`);
  if (!/^\/devtools\/browser\/[0-9a-f-]+$/i.test(rawPath)) {
    throw new Error(`invalid browser path in DevToolsActivePort: ${rawPath}`);
  }
  const cdp = await connect(`ws://127.0.0.1:${port}${rawPath}`);
  cleanup.push(() => cdp.close());

  const errors: string[] = [];
  const unmocked: string[] = [];
  const swLog: string[] = [];
  const google = { count: 0, texts: [] as string[] };
  let handler: GoogleHandler | undefined;
  /** Sessions we set up, by id; the test page is the first page, `sw` our worker. */
  const sessions = new Map<string, { targetId: string; label: string }>();
  let pageSession: string | undefined;
  let swSession: string | undefined;
  /** The extension's isolated worlds in the test page: execution context id -> frame id. */
  const contentWorlds = new Map<number, string>();
  /** Whether the worker runs with interception on; stops are counted for stopServiceWorker. */
  let swReady = false;
  let swStops = 0;
  /** Set once the browser is in developer mode, which a reload needs (see reloadExtension). */
  let developerMode = false;

  const evaluateIn = async <T>(sessionId: string, expression: string): Promise<T> => {
    const params = { expression, awaitPromise: true, returnByValue: true };
    const reply = await cdp.send('Runtime.evaluate', params, sessionId);
    const details = reply.exceptionDetails;
    if (details) throw new Error(details.exception?.description ?? details.text);
    return reply.result?.value as T;
  };

  const fulfillGoogle = async (requestId: string, request: Json, sessionId: string) => {
    const url = new URL(request.url);
    const single = url.pathname.endsWith('/single');
    const html = !single && url.searchParams.get('format') === 'html';
    const query = single ? url.searchParams : new URLSearchParams(request.postData ?? '');
    const texts = query.getAll('q');
    google.count += 1;
    google.texts.push(...texts);
    const replies = await Promise.all(
      texts.map(async (text) => (await handler?.(text, { html, single })) ?? mockTranslate(text)),
    );
    const status = replies.find((reply) => typeof reply === 'number');
    const body = status ? '' : JSON.stringify(single ? [[[replies[0], 'en']]] : replies);
    const headers = [{ name: 'content-type', value: 'application/json; charset=utf-8' }];
    const reply = { requestId, responseCode: status ?? 200, responseHeaders: headers };
    const encoded = Buffer.from(body).toString('base64');
    // A slow reply can arrive after its request was cancelled (the page stopped): not an error.
    return cdp
      .send('Fetch.fulfillRequest', { ...reply, body: encoded }, sessionId)
      .catch((error: Error) => {
        if (!/Invalid InterceptionId/.test(error.message)) throw error;
        return {};
      });
  };

  const intercept = (sessionId: string) =>
    cdp.send('Fetch.enable', { patterns: [{ urlPattern: '*' }] }, sessionId);

  /** Interception on, then resume: the worker counts as ready only after both. */
  const armWorker = async (sessionId: string) => {
    await intercept(sessionId);
    await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    swSession = sessionId;
    swReady = true;
  };

  const onAttached = async ({ sessionId, targetInfo, waitingForDebugger }: Json) => {
    const { type, url, targetId } = targetInfo;
    const ours = type === 'service_worker' && url.startsWith(`chrome-extension://${extensionId}/`);
    try {
      if (!ours && type !== 'page') return;
      if (!ours) pageSession ??= sessionId;
      const label = ours ? 'sw' : sessionId === pageSession ? 'page' : `page ${url}`;
      sessions.set(sessionId, { targetId, label });
      const domains = ['Runtime.enable', 'Log.enable'];
      if (sessionId === pageSession) domains.push('Page.enable');
      await Promise.all(domains.map((method) => cdp.send(method, {}, sessionId)));
      // Pages are intercepted too (the test page with its content script, extension pages):
      // an unmocked request from them is failed and listed like one from the worker.
      if (ours) await armWorker(sessionId);
      else await intercept(sessionId);
    } finally {
      if (waitingForDebugger) await cdp.send('Runtime.runIfWaitingForDebugger', {}, sessionId);
    }
  };

  const onRequest = ({ requestId, request }: Json, sessionId: string) => {
    if (request.url.startsWith(GOOGLE)) return fulfillGoogle(requestId, request, sessionId);
    if (LOCAL.test(request.url)) return cdp.send('Fetch.continueRequest', { requestId }, sessionId);
    unmocked.push(request.url);
    return cdp.send('Fetch.failRequest', { requestId, errorReason: 'NameNotResolved' }, sessionId);
  };

  cdp.on((method, params, sessionId = '') => {
    const label = sessions.get(sessionId)?.label;
    const fromSw = label === 'sw';
    const report = (error: Error) => {
      // A target can close in the middle of its set-up (a closed window, a stopped worker).
      if (sessions.has(params.sessionId ?? sessionId)) errors.push(`${method}: ${error.message}`);
    };
    if (method === 'Target.attachedToTarget') onAttached(params).catch(report);
    else if (method === 'Target.detachedFromTarget') {
      sessions.delete(params.sessionId);
      if (params.sessionId === swSession) swReady = false;
    } else if (sessionId === pageSession && method === 'Runtime.executionContextCreated') {
      const { id, origin: contextOrigin, auxData } = params.context;
      if (auxData?.type === 'isolated' && contextOrigin === `chrome-extension://${extensionId}`) {
        contentWorlds.set(id, auxData.frameId);
      }
    } else if (sessionId === pageSession && method === 'Runtime.executionContextDestroyed') {
      contentWorlds.delete(params.executionContextId);
    } else if (sessionId === pageSession && method === 'Runtime.executionContextsCleared') {
      contentWorlds.clear();
    } else if (
      fromSw &&
      /^(Inspector.targetCrashed|Runtime.executionContextsCleared)$/.test(method)
    ) {
      // A stopped worker keeps its session and reports a "crash"; a restart clears contexts.
      if (swReady) swStops += 1;
      swReady = false;
    } else if (fromSw && method === 'Runtime.executionContextCreated') {
      armWorker(sessionId).catch(report);
    } else if (method === 'Runtime.exceptionThrown' && label) {
      const d = params.exceptionDetails;
      const text = d.exception?.description ?? d.text;
      errors.push(`${label}: ${text}`);
      if (fromSw) swLog.push(`[exception] ${text}`);
    } else if (method === 'Log.entryAdded' && label) {
      const { level, source, text, url } = params.entry;
      // Network errors are expected with mocked failures; unmocked requests are listed apart.
      if (level === 'error' && source !== 'network') errors.push(`${label}: ${text} ${url ?? ''}`);
      if (fromSw) swLog.push(`[log ${level}] ${text}`);
    } else if (method === 'Runtime.consoleAPICalled' && fromSw) {
      const text = params.args.map((a: Json) => a.value ?? a.description ?? a.type).join(' ');
      swLog.push(`[console.${params.type}] ${text}`);
    } else if (method === 'Fetch.requestPaused') {
      onRequest(params, sessionId).catch(report);
    }
  });

  await cdp.send('Target.setAutoAttach', {
    autoAttach: true,
    waitForDebuggerOnStart: true,
    flatten: true,
  });
  const page = () => {
    if (!pageSession) throw new Error('the test page is gone');
    return pageSession;
  };
  const evaluate = <T>(expression: string) => evaluateIn<T>(page(), expression);
  const workers = (method: string, params: Json = {}) =>
    cdp.send('ServiceWorker.enable', {}, page()).then(() => cdp.send(method, params, page()));
  const sw = async <T>(expression: string) => {
    // A stopped worker only restarts on an event; start it as the browser would.
    const scopeURL = `chrome-extension://${extensionId}/`;
    if (!swReady && swStops > 0) await workers('ServiceWorker.startWorker', { scopeURL });
    await waitFor(() => swReady, { message: 'the service worker' });
    return evaluateIn<T>(swSession ?? '', expression);
  };
  // Just after resuming, the worker's context can still lack the extension bindings.
  await waitFor(() => pageSession && sw(`typeof chrome === 'object' && !!chrome.tabs`), {
    timeout: 15_000,
    message: 'the extension service worker',
  });
  // The only tab at start-up is the test page; extension pages open in windows of their own.
  const tabIds = await sw<number[]>('chrome.tabs.query({}).then((tabs) => tabs.map((t) => t.id))');
  const [tabId] = tabIds;
  if (tabIds.length !== 1 || tabId === undefined) {
    throw new Error(`expected one tab at start, found ${tabIds.length}`);
  }

  const message = (type: string, data: unknown) =>
    `{ id: Date.now(), type: ${JSON.stringify(type)}, data: ${JSON.stringify(data ?? null)}, timestamp: Date.now() }`;
  const unwrap = <T>(reply: Json | undefined): T => {
    if (!reply || reply.err) throw new Error(`message failed: ${JSON.stringify(reply?.err)}`);
    return reply.res as T;
  };

  /** Waits for a page target's session and wraps it as an ExtPage. */
  const attachExtPage = async (
    targetId: string,
    path: string,
    preload?: string,
  ): Promise<ExtPage> => {
    const sessionId = await waitFor(
      () => [...sessions].find(([, s]) => s.targetId === targetId)?.[0],
      { message: `${path} to attach` },
    );
    const run = <T>(expression: string) => evaluateIn<T>(sessionId, expression);
    if (preload !== undefined) {
      // The target was created blank: the script is in place before the page itself loads.
      await cdp.send('Page.enable', {}, sessionId);
      await cdp.send('Page.addScriptToEvaluateOnNewDocument', { source: preload }, sessionId);
      const url = `chrome-extension://${extensionId}/${path}`;
      await cdp.send('Page.navigate', { url }, sessionId);
    }
    // A new target starts on about:blank, which is already "complete": wait for the page.
    const loaded = `location.pathname === '/${path}' && document.readyState === 'complete' && !!globalThis.chrome?.runtime?.id`;
    await waitFor(() => run(loaded), { message: `${path} to load` });
    return {
      evaluate: run,
      send: async <T>(type: string, data?: unknown) =>
        unwrap<T>(await run<Json>(`chrome.runtime.sendMessage(${message(type, data)})`)),
      close: async () => {
        // The page may have closed itself (the panel does once translation starts).
        await cdp.send('Target.closeTarget', { targetId }).catch((error: unknown) => {
          if (!/No target with given id|Target closed/i.test(String(error))) throw error;
        });
      },
    };
  };

  return {
    extensionId,
    tabId,
    google,
    errors,
    unmocked,
    mockGoogle(next) {
      handler = next;
    },
    resetLogs() {
      for (const list of [errors, unmocked, swLog, google.texts]) list.length = 0;
      google.count = 0;
    },
    async openPage(fixture) {
      // The test window is not the one the OS focuses: without this `document.hasFocus()` is
      // false, and the palette (like the selection shortcut) would not open.
      await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }, page());
      // A marker on the old document tells a reload of the same URL apart.
      await evaluate('window.__etStale = true');
      await cdp.send('Page.navigate', { url: `${origin}/${fixture}` }, page());
      await waitFor(() => evaluate(`!window.__etStale && document.readyState === 'complete'`), {
        message: `${fixture} to load`,
      });
    },
    evaluate,
    async evalInContentWorld<T>(expression: string) {
      const contextId = await waitFor(
        async () => {
          const { frameTree } = await cdp.send('Page.getFrameTree', {}, page());
          return [...contentWorlds].find(([, frameId]) => frameId === frameTree.frame.id)?.[0];
        },
        { message: "the content script's world" },
      );
      const params = { expression, contextId, awaitPromise: true, returnByValue: true };
      const reply = await cdp.send('Runtime.evaluate', params, page());
      const details = reply.exceptionDetails;
      if (details) throw new Error(details.exception?.description ?? details.text);
      return reply.result?.value as T;
    },
    async setViewport(width, height) {
      const metrics = { width, height, deviceScaleFactor: 1, mobile: false };
      await cdp.send('Emulation.setDeviceMetricsOverride', metrics, page());
    },
    async clearViewport() {
      await cdp.send('Emulation.clearDeviceMetricsOverride', {}, page());
    },
    sw,
    async tell<T>(type: string, data?: unknown) {
      // Retried only while the content script is not listening yet; once the message was
      // delivered any answer or other error is final, so non-idempotent messages never repeat.
      const send = `chrome.tabs.sendMessage(${tabId}, ${message(type, data)}, { frameId: 0 })`;
      // waitFor swallows callback errors and keeps polling, so a final error is returned as a
      // truthy `{ error }` (ending the poll) and rethrown below instead of thrown in the callback.
      const reply = await waitFor(
        async () => {
          try {
            return { value: await sw<Json>(send) };
          } catch (error) {
            if (/Receiving end does not exist|Could not establish connection/.test(String(error))) {
              return undefined;
            }
            return { error };
          }
        },
        { message: `an answer to ${type}` },
      );
      if ('error' in reply) throw reply.error;
      return unwrap<T>(reply.value);
    },
    async extPage(path, { preload } = {}) {
      const url =
        preload === undefined ? `chrome-extension://${extensionId}/${path}` : 'about:blank';
      const { targetId } = await cdp.send('Target.createTarget', { url, newWindow: true });
      return attachExtPage(targetId, path, preload);
    },
    async waitForExtPage(path) {
      const url = `chrome-extension://${extensionId}/${path}`;
      const targetId = await waitFor(
        async () => {
          const { targetInfos } = await cdp.send('Target.getTargets');
          return (targetInfos as Json[]).find((t) => t.type === 'page' && t.url === url)?.targetId;
        },
        { message: `${path} to open` },
      );
      // The browser opens popups itself and auto-attach does not reach them.
      if (![...sessions.values()].some((entry) => entry.targetId === targetId)) {
        await cdp.send('Target.attachToTarget', { targetId, flatten: true });
      }
      return attachExtPage(targetId, path);
    },
    async shadow<T>(tagName: string, fn: string) {
      const { root } = await cdp.send('DOM.getDocument', { depth: -1, pierce: true }, page());
      const find = (node: Json): Json | undefined => {
        if (node.nodeName === tagName.toUpperCase()) return node;
        const inner = [...(node.children ?? []), ...(node.shadowRoots ?? [])];
        if (node.contentDocument) inner.push(node.contentDocument);
        for (const child of inner) {
          const found = find(child);
          if (found) return found;
        }
        return undefined;
      };
      const shadowRoot = find(root)?.shadowRoots?.[0];
      if (!shadowRoot) throw new Error(`no <${tagName}> with a shadow root`);
      const { object } = await cdp.send(
        'DOM.resolveNode',
        { backendNodeId: shadowRoot.backendNodeId },
        page(),
      );
      const reply = await cdp.send(
        'Runtime.callFunctionOn',
        {
          objectId: object.objectId,
          functionDeclaration: `function () { return (${fn})(this); }`,
          awaitPromise: true,
          returnByValue: true,
        },
        page(),
      );
      if (reply.exceptionDetails) {
        const d = reply.exceptionDetails;
        throw new Error(d.exception?.description ?? d.text);
      }
      return reply.result?.value as T;
    },
    async stopServiceWorker() {
      const stops = swStops;
      await workers('ServiceWorker.stopAllWorkers');
      await waitFor(() => swStops > stops, { message: 'the service worker to stop' });
    },
    async reloadExtension() {
      if (!developerMode) {
        // Without developer mode the browser disables a command-line extension on reload.
        // chrome://extensions (attached like any page) can switch it on.
        const { targetId } = await cdp.send('Target.createTarget', { url: 'chrome://extensions' });
        const sessionId = await waitFor(
          () => [...sessions].find(([, entry]) => entry.targetId === targetId)?.[0],
          { message: 'chrome://extensions to attach' },
        );
        await waitFor(() => evaluateIn<boolean>(sessionId, '!!chrome.developerPrivate'), {
          message: 'chrome.developerPrivate',
        });
        const turnOn =
          'chrome.developerPrivate.updateProfileConfiguration({ inDeveloperMode: true })';
        await evaluateIn(sessionId, turnOn);
        await cdp.send('Target.closeTarget', { targetId });
        developerMode = true;
      }
      const old = swSession;
      // Deferred, so that the answer leaves before the worker goes away.
      await sw('setTimeout(() => chrome.runtime.reload(), 20), true');
      await waitFor(() => !sessions.has(old ?? ''), { message: 'the old worker to go away' });
      await waitFor(() => swReady && swSession !== old, {
        timeout: 15_000,
        message: 'the reloaded worker',
      });
      await sw(`typeof chrome === 'object' && !!chrome.tabs`);
    },
    async trustedClick(target) {
      const point =
        typeof target === 'string'
          ? await evaluate<Point | null>(`(() => {
              const r = document.querySelector(${JSON.stringify(target)})?.getBoundingClientRect();
              return r ? { x: r.x + r.width / 2, y: r.y + r.height / 2 } : null;
            })()`)
          : target;
      if (!point) throw new Error(`nothing to click at ${JSON.stringify(target)}`);
      for (const type of ['mouseMoved', 'mousePressed', 'mouseReleased']) {
        const button = type === 'mouseMoved' ? 'none' : 'left';
        await cdp.send(
          'Input.dispatchMouseEvent',
          { type, ...point, button, clickCount: 1 },
          page(),
        );
      }
    },
    async input(method, params) {
      await cdp.send(method, params, page());
    },
    assertNoErrors() {
      const problems = [...errors, ...unmocked.map((url) => `unmocked request: ${url}`)];
      if (problems.length > 0) throw new Error(`browser errors:\n${problems.join('\n')}`);
    },
    async saveArtifacts(name) {
      const dir = join(RESULTS, name.replace(/[^\w.-]+/g, '_').slice(0, 120));
      mkdirSync(dir, { recursive: true });
      const log = [...swLog, '--- errors', ...errors, '--- unmocked', ...unmocked];
      writeFileSync(join(dir, 'sw.log'), `${log.join('\n')}\n`);
      const shot = await cdp.send('Page.captureScreenshot', {}, page()).catch(() => null);
      if (shot) writeFileSync(join(dir, 'page.png'), Buffer.from(shot.data, 'base64'));
    },
    close,
  };
}

/**
 * Per-test hooks: fresh logs and the default Google mock before each test (a handler left
 * behind by a failed test must not reach the next one); after a failed attempt (a retry that passes
 * later included), artifacts in test-results/e2e/<test>, or <test>_retry_<n> for a retry, so
 * a failing retry keeps the first failure's; then, with `closeAfterEach`, the browser closed
 * (one hook, so the order is fixed).
 */
export function trackTests(current: () => Harness | undefined, { closeAfterEach = false } = {}) {
  beforeEach(() => {
    current()?.resetLogs();
    current()?.mockGoogle();
  });
  afterEach(async (context) => {
    const h = current();
    if (!h) return;
    try {
      const { state, retryCount = 0 } = context.task.result ?? {};
      const name = retryCount ? `${context.task.name} retry ${retryCount}` : context.task.name;
      if (state === 'fail') await h.saveArtifacts(name);
    } finally {
      if (closeAfterEach) await h.close();
    }
  });
}
