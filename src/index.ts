/**
 * The service OpenChamber starts: a loopback HTTP server holding one Chrome
 * window per profile (there are three; see env.ts).
 *
 * Wire contract (packages/sdk/GUEST_SERVICES.md):
 * - `GET /health` answers 200 once the process is up. It never starts Chrome,
 *   because the host polls it before every first action and a slow answer
 *   would look like a crash.
 * - `POST /browser-control` takes one `browser.*` action the host already
 *   validated, and answers `{ ok: true, data }` or `{ ok: false, error }`.
 *   Every action carries the chat it came from; that chat's profile picks the
 *   window (see chats.ts and sessions.ts).
 * - `GET /state` lists the profiles and the chats that use them.
 * - `POST /chat-profile` points a chat at one of the profiles, for the panel.
 * - `POST /navigate` opens a page in the default profile, for the panel.
 *
 * Every request, ready included, needs the host's bearer token. The service
 * binds 127.0.0.1 only. Actions run one at a time per profile: two actions on
 * the same profile would fight over the same window.
 */
import http from 'node:http';
import path from 'node:path';
import { writeFileSync } from 'node:fs';

import { readBrowserProviderRequest, type BrowserProviderResult } from '@openchamber/sdk';

import { runAction } from './actions.ts';
import { isChromeLaunchError } from './launcher.ts';
import { profiles } from './sessions.ts';
import { chats } from './chats.ts';
import { HOSTED, PROFILE_NAMES, SERVICE_PORT, SERVICE_TOKEN, isProfileName } from './env.ts';
import { describeError } from './util.ts';

const log = (message: string): void => {
  console.error(`[openchamber-chrome] ${message}`);
};

/** One action at a time per profile; different profiles run side by side. */
const queues = new Map<string, Promise<void>>();
const serialize = <T>(profile: string, task: () => Promise<T>): Promise<T> => {
  const previous = queues.get(profile) ?? Promise.resolve();
  const next = previous.then(task, task);
  queues.set(
    profile,
    next.then(
      () => undefined,
      () => undefined,
    ),
  );
  return next;
};

const readBody = (request: http.IncomingMessage): Promise<string> =>
  new Promise((resolve, reject) => {
    let body = '';
    request.on('data', (chunk) => {
      body += chunk;
      if (body.length > 1_000_000) {
        reject(new Error('Request body is too large'));
        request.destroy();
      }
    });
    request.on('end', () => resolve(body));
    request.on('error', reject);
  });

const answer = (response: http.ServerResponse, status: number, body: unknown): void => {
  const text = JSON.stringify(body);
  response.writeHead(status, {
    'Content-Type': 'application/json',
    'Content-Length': Buffer.byteLength(text),
  });
  response.end(text);
};

const providerError = (error: unknown): string => {
  if (isChromeLaunchError(error)) return error.message;
  const text = describeError(error);
  if (text.includes('Executable doesn') || text.includes('browserType.launch')) {
    return `Chrome could not be started: ${text}`;
  }
  return text;
};

const handleBrowserControl = async (body: string): Promise<{ status: number; payload: BrowserProviderResult }> => {
  const request = readBrowserProviderRequest(body);
  if (!request) {
    return { status: 400, payload: { ok: false, error: 'Not a browser action' } };
  }
  const sessionId = request.context.sessionId;
  const driver = profiles.for(sessionId);
  try {
    const result = await serialize(driver.name, () => runAction(driver.name, driver, request));
    return { status: 200, payload: result };
  } catch (error) {
    driver.log(`${request.action} failed: ${providerError(error)}`);
    return { status: 200, payload: { ok: false, error: providerError(error) } };
  }
};

const handleState = (): unknown => ({
  ok: true,
  profiles: profiles.list().map((entry) => ({
    name: entry.name,
    chrome: entry.status.chrome,
    connected: entry.status.connected,
    pages: entry.status.pages,
    profile: entry.status.profile,
    port: entry.status.port,
    lastError: entry.status.lastError,
    idleSeconds: Math.round(entry.idleMs / 1_000),
    log: entry.recentLog,
  })),
  chats: chats.list(),
});

/** Points a chat at a profile. The choice is kept across restarts (see chats.ts). */
const handleChatProfile = (body: string): { status: number; payload: unknown } => {
  let parsed: unknown = null;
  try {
    parsed = JSON.parse(body);
  } catch {
    // Refused below.
  }
  const fields: { sessionId?: unknown; profile?: unknown } =
    Object(parsed) === parsed && parsed !== null ? (parsed as { sessionId?: unknown; profile?: unknown }) : {};
  const { sessionId, profile } = fields;
  if (typeof sessionId !== 'string' || sessionId.length === 0 || sessionId.length > 1024) {
    return { status: 400, payload: { ok: false, error: 'sessionId is required' } };
  }
  if (!isProfileName(profile)) {
    return { status: 400, payload: { ok: false, error: `profile must be one of ${PROFILE_NAMES.join(', ')}` } };
  }
  chats.assign(sessionId, profile);
  return { status: 200, payload: { ok: true, sessionId, profile } };
};

const handleNavigate = async (body: string): Promise<{ status: number; payload: unknown }> => {
  let target = '';
  try {
    const parsed: unknown = JSON.parse(body);
    if (Object(parsed) === parsed && parsed !== null) {
      const candidate = (parsed as { url?: unknown }).url;
      if (typeof candidate === 'string') target = candidate.trim();
    }
  } catch {
    // Fall through to the refusal below.
  }
  if (target.length === 0) return { status: 400, payload: { ok: false, error: 'url is required' } };
  if (!/^https?:\/\//i.test(target)) target = `https://${target}`;
  try {
    new URL(target);
  } catch {
    return { status: 400, payload: { ok: false, error: `${target} is not a URL` } };
  }

  // The panel speaks for the default profile: the one a person signs into once,
  // which the CLI and chat-less actions also use.
  const driver = profiles.for(null);
  return serialize(driver.name, async () => {
    const opened = await driver.openTab(target);
    await driver.waitForSettle(opened.page, 8_000);
    return { status: 200, payload: { ok: true, url: opened.page.url() } };
  });
};

export const createService = (): http.Server =>
  http.createServer((request, response) => {
    if (request.headers.authorization !== `Bearer ${SERVICE_TOKEN}`) {
      answer(response, 401, { ok: false, error: 'unauthorized' });
      return;
    }
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.pathname === '/health') {
      answer(response, 200, { ok: true });
      return;
    }
    if (url.pathname === '/state' && request.method === 'GET') {
      answer(response, 200, handleState());
      return;
    }
    if (url.pathname === '/chat-profile' && request.method === 'POST') {
      void readBody(request)
        .then((body) => handleChatProfile(body))
        .then(({ status, payload }) => answer(response, status, payload))
        .catch((error: unknown) => answer(response, 500, { ok: false, error: providerError(error) }));
      return;
    }
    if (url.pathname === '/navigate' && request.method === 'POST') {
      void readBody(request)
        .then(handleNavigate)
        .then(({ status, payload }) => answer(response, status, payload))
        .catch((error: unknown) => answer(response, 500, { ok: false, error: providerError(error) }));
      return;
    }
    if (url.pathname === '/browser-control' && request.method === 'POST') {
      void readBody(request)
        .then(handleBrowserControl)
        .then(({ status, payload }) => answer(response, status, payload))
        .catch((error: unknown) => {
          log(`request failed: ${providerError(error)}`);
          answer(response, 200, { ok: false, error: providerError(error) });
        });
      return;
    }
    answer(response, 404, { ok: false, error: 'not-found' });
  });

const isMain = (): boolean => {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return path.resolve(__filename) === path.resolve(entry);
  } catch {
    return false;
  }
};

/**
 * The host stops an idle service with SIGTERM. The windows stay: a session's
 * login or half-filled form lives in them, and the next action attaches to them
 * again (see scripts/patch-bundle.mjs). Set
 * OPENCHAMBER_CHROME_CLOSE_ON_STOP=1 to close every window this service started
 * when it stops. Ctrl-C keeps the close, because that is a person at a keyboard.
 */
const stop = (cause: string, closeWindows: boolean): void => {
  log(`stopping (${cause})`);
  const finish = (): never => process.exit(0);
  if (closeWindows) {
    void profiles.closeAll({ hard: true }).then(finish, finish);
    setTimeout(finish, 30_000).unref();
    return;
  }
  finish();
};

const CLOSE_ON_STOP = process.env.OPENCHAMBER_CHROME_CLOSE_ON_STOP === '1';

if (isMain()) {
  if (!HOSTED) {
    console.error(
      '[openchamber-chrome] OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN are required. ' +
        'OpenChamber sets them when it starts this service from Settings → Extensions.',
    );
    process.exit(1);
  }
  const server = createService();
  const requestedPort = SERVICE_PORT ?? 0;
  server.listen(requestedPort, '127.0.0.1', () => {
    const address = server.address();
    const boundPort = typeof address === 'object' && address ? address.port : requestedPort;
    log(`service listening on 127.0.0.1:${boundPort}`);
    // Tests read this file to learn the port that was actually bound; the host
    // polls /health on the port it chose itself.
    const readyFile = process.env.OPENCHAMBER_SERVICE_READY_FILE;
    if (readyFile) {
      try {
        writeFileSync(readyFile, String(boundPort));
      } catch {
        // A ready file that cannot be written changes nothing for the host.
      }
    }
  });
  server.on('error', (error) => {
    console.error(`[openchamber-chrome] ${describeError(error)}`);
    process.exit(1);
  });
  process.on('SIGTERM', () => stop('SIGTERM', CLOSE_ON_STOP));
  process.on('SIGINT', () => stop('SIGINT', true));
  process.on('disconnect', () => stop('parent gone', true));
}
