/**
 * Three profiles, one window each: chats share the window of their profile and
 * nothing else.
 *
 * A chat uses the default profile until it is pointed at another in the panel
 * (see src/chats.ts). Chats on one profile share its window, cookies and tabs.
 * Chats on different profiles share nothing. A chat's choice survives a restart,
 * and a profile keeps its logins and User-Agent when its window is relaunched.
 *
 * Focus is measured against the app that was in front when the test started;
 * if the provider activates a window, this test says so.
 *
 *   npm run build && npm run test:sessions
 */
import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceEntry = path.join(root, 'service', 'main.cjs');

const HOST = '127.0.0.1';
const READY_FILE = path.join(os.tmpdir(), `oc-chrome-sessions-port-${randomBytes(6).toString('hex')}`);
const TOKEN = randomBytes(16).toString('hex');
const PROFILE = mkdtempSync(path.join(os.tmpdir(), 'oc-chrome-sessions-'));
/** Away from the user's own provider port: the default profile here is this test's own. */
const BASE_DEBUG_PORT = 8800 + Math.floor(Math.random() * 150);
const CHAT_A = 'ses_alpha00000000000000000';
const CHAT_B = 'ses_beta111111111111111111';
const CHAT_C = 'ses_gamma22222222222222222';

let port = 0;
let failures = 0;
let requestId = 0;
let service = null;
let serviceLog = '';

const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : `\n      ${detail}`}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const frontmost = () => {
  try {
    return execFileSync(
      'osascript',
      ['-e', 'tell application "System Events" to get name of first application process whose frontmost is true'],
      { encoding: 'utf8' },
    ).trim();
  } catch {
    return '(unknown)';
  }
};

const waitFor = async (probe, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await sleep(250);
  }
  return false;
};

const request = (method, route, body) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const call = http.request(
      {
        host: HOST,
        port,
        method,
        path: route,
        headers: {
          Authorization: `Bearer ${TOKEN}`,
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => resolve({ status: response.statusCode, body: text ? JSON.parse(text) : null }));
      },
    );
    call.on('error', reject);
    if (payload) call.write(payload);
    call.end();
  });

const action = (sessionId, name, parameters) => {
  requestId += 1;
  return request('POST', '/browser-control', {
    requestId: `sessions-${requestId}`,
    action: name,
    parameters,
    context: { directory: root, sessionId },
  });
};

/** Chrome's own /json/version for a debug port, or null while nothing answers there. */
const debugVersion = async (debugPort) => {
  try {
    const response = await fetch(`http://${HOST}:${debugPort}/json/version`, { signal: AbortSignal.timeout(1_000) });
    return response.ok ? await response.json() : null;
  } catch {
    return null;
  }
};

const prefixOf = (tabId) => (typeof tabId === 'string' ? tabId.split(':')[0] : undefined);

/** Sets a cookie on `?set=1` and echoes the cookies it was sent, so a login can be seen. */
const pageServer = http.createServer((incoming, outgoing) => {
  const url = incoming.url ?? '/';
  const title = url.slice(1).split('?')[0] || 'home';
  const headers = { 'Content-Type': 'text/html' };
  if (url.includes('set=1')) headers['Set-Cookie'] = 'oc_test=kept; Max-Age=86400; Path=/';
  outgoing.writeHead(200, headers);
  outgoing.end(
    `<!doctype html><html><head><title>${title}</title></head><body><h1 id="h">${title}</h1>` +
      `<p id="cookie">${incoming.headers.cookie ?? ''}</p><input id="name" placeholder="name" value=""></body></html>`,
  );
});
await new Promise((resolve) => pageServer.listen(0, HOST, resolve));
const base = `http://${HOST}:${pageServer.address().port}/`;

const startService = async (extraEnv = {}) => {
  port = 0;
  // A stale file from the previous service would name the wrong port.
  rmSync(READY_FILE, { force: true });
  const child = spawn(process.execPath, [serviceEntry], {
    env: {
      ...process.env,
      OPENCHAMBER_SERVICE_PORT: '0',
      OPENCHAMBER_SERVICE_TOKEN: TOKEN,
      OPENCHAMBER_CHROME_PROFILE: PROFILE,
      OPENCHAMBER_SERVICE_READY_FILE: READY_FILE,
      OPENCHAMBER_CHROME_DEBUG_PORT: String(BASE_DEBUG_PORT),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const collect = (chunk) => {
    serviceLog += String(chunk);
    process.stdout.write(`[service] ${chunk}`);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const healthy = await waitFor(async () => {
    if (port === 0) {
      try {
        port = Number(readFileSync(READY_FILE, 'utf8').trim());
      } catch {
        return false;
      }
    }
    try {
      return (await request('GET', '/health')).status === 200;
    } catch {
      return false;
    }
  });
  if (!healthy) {
    child.kill('SIGKILL');
    throw new Error(`the service did not become healthy\n${serviceLog}`);
  }
  return child;
};

/** SIGTERM, as the host does, then SIGKILL if it does not leave in time. */
const stopService = (child) =>
  new Promise((resolve) => {
    if (!child || child.exitCode !== null || child.signalCode !== null) {
      resolve();
      return;
    }
    const timer = setTimeout(() => child.kill('SIGKILL'), 8_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });

try {
  // With CLOSE_ON_STOP every window is closed when the service stops, so the
  // relaunch checks at the end start from a closed window.
  service = await startService({ OPENCHAMBER_CHROME_CLOSE_ON_STOP: '1' });
  const userApp = frontmost();

  // Chats A and B have no choice yet: both use the default profile and share its window.
  const openA = await action(CHAT_A, 'browser.open', { url: `${base}alpha` });
  const openB = await action(CHAT_B, 'browser.open', { url: `${base}beta` });
  check('chat A opens a tab in the default profile', openA.body?.ok === true, JSON.stringify(openA.body).slice(0, 200));
  check('chat B opens a tab in the default profile', openB.body?.ok === true, JSON.stringify(openB.body).slice(0, 200));
  check(
    'chats A and B share one profile prefix',
    typeof prefixOf(openA.body?.data?.tabId) === 'string' && prefixOf(openA.body?.data?.tabId) === prefixOf(openB.body?.data?.tabId),
    `${openA.body?.data?.tabId} vs ${openB.body?.data?.tabId}`,
  );
  const snapB = await action(CHAT_B, 'browser.snapshot', {});
  check('chat B sees both tabs of the shared window', (snapB.body?.data?.tabs ?? []).length >= 2, JSON.stringify(snapB.body?.data?.tabs ?? []).slice(0, 300));
  const readA = await action(CHAT_B, 'browser.snapshot', { tabId: openA.body?.data?.tabId });
  check('chat B can act on a tab chat A opened', readA.body?.ok === true && readA.body.data?.title === 'alpha', JSON.stringify(readA.body).slice(0, 200));

  // Chat C is pointed at the work profile in the panel, so it gets a window of its own.
  const pointed = await request('POST', '/chat-profile', { sessionId: CHAT_C, profile: 'work' });
  check('the panel can point a chat at a profile', pointed.status === 200 && pointed.body?.ok === true, JSON.stringify(pointed.body));
  const openC = await action(CHAT_C, 'browser.open', { url: `${base}gamma` });
  check('chat C opens in the work profile', openC.body?.ok === true, JSON.stringify(openC.body).slice(0, 200));
  check(
    'the work profile has a different tab prefix',
    prefixOf(openC.body?.data?.tabId) !== prefixOf(openA.body?.data?.tabId),
    `${openC.body?.data?.tabId} vs ${openA.body?.data?.tabId}`,
  );
  const refused = await action(CHAT_C, 'browser.snapshot', { tabId: openA.body?.data?.tabId });
  check(
    'a tab from the default profile is refused in the work profile',
    refused.body?.ok === false && String(refused.body.error).includes("another profile's window"),
    JSON.stringify(refused.body).slice(0, 200),
  );

  let state = await request('GET', '/state');
  const profileNamed = (name) => (state.body?.profiles ?? []).find((entry) => entry.name === name) ?? {};
  check('three profiles are reported', (state.body?.profiles ?? []).length === 3, JSON.stringify((state.body?.profiles ?? []).map((entry) => entry.name)));
  check(
    'default and work have a window, personal has none yet',
    profileNamed('default').chrome === 'ready' && profileNamed('work').chrome === 'ready' && profileNamed('personal').chrome === 'stopped',
    JSON.stringify((state.body?.profiles ?? []).map((entry) => [entry.name, entry.chrome])),
  );
  check(
    'each profile has its own folder and debug port',
    new Set(['default', 'work', 'personal'].map((name) => profileNamed(name).profile)).size === 3 &&
      new Set(['default', 'work', 'personal'].map((name) => profileNamed(name).port)).size === 3,
    JSON.stringify((state.body?.profiles ?? []).map((entry) => [entry.profile, entry.port])),
  );
  check('the work folder sits under profiles/', profileNamed('work').profile === path.join(PROFILE, 'profiles', 'work', 'chrome'), profileNamed('work').profile);

  // Logins stay with their profile. Chat A signs in on the default profile;
  // chat B shares that login, chat C on the work profile does not see it.
  await action(CHAT_A, 'browser.open', { url: `${base}relaunch?set=1` });
  const sharedLogin = await action(CHAT_B, 'browser.open', { url: `${base}relaunch` });
  const sharedText = await action(CHAT_B, 'browser.snapshot', { tabId: sharedLogin.body?.data?.tabId, selector: '#cookie' });
  check('chat B, on the same profile, sees the login', (sharedText.body?.data?.text ?? '').includes('oc_test=kept'), JSON.stringify(sharedText.body?.data?.text));
  const workLogin = await action(CHAT_C, 'browser.open', { url: `${base}relaunch` });
  const workText = await action(CHAT_C, 'browser.snapshot', { tabId: workLogin.body?.data?.tabId, selector: '#cookie' });
  check('the work profile does not see the default login', !(workText.body?.data?.text ?? '').includes('oc_test=kept'), JSON.stringify(workText.body?.data?.text));

  // Chat B moves to personal: its next action opens there and the default window is left alone.
  const defaultTabsBefore = (await action(CHAT_A, 'browser.snapshot', {})).body?.data?.tabs?.length ?? 0;
  const moved = await request('POST', '/chat-profile', { sessionId: CHAT_B, profile: 'personal' });
  check('chat B moves to personal', moved.status === 200, JSON.stringify(moved.body));
  const openBPersonal = await action(CHAT_B, 'browser.open', { url: `${base}personal` });
  check(
    'chat B opens in the personal profile',
    openBPersonal.body?.ok === true && prefixOf(openBPersonal.body?.data?.tabId) !== prefixOf(openA.body?.data?.tabId),
    JSON.stringify(openBPersonal.body).slice(0, 200),
  );
  const defaultTabsAfter = (await action(CHAT_A, 'browser.snapshot', {})).body?.data?.tabs?.length ?? 0;
  check('the default window is unchanged by the move', defaultTabsAfter === defaultTabsBefore, `${defaultTabsBefore} before, ${defaultTabsAfter} after`);

  const badProfile = await request('POST', '/chat-profile', { sessionId: CHAT_B, profile: 'nope' });
  check('an unknown profile is refused', badProfile.status === 400, JSON.stringify(badProfile.body));
  const noChat = await request('POST', '/chat-profile', { profile: 'work' });
  check('a request without a chat is refused', noChat.status === 400, JSON.stringify(noChat.body));

  // Nothing the provider did should have pulled a window in front of the user.
  const nowFrontmost = frontmost();
  check('the user stays in front of every window', nowFrontmost === userApp || nowFrontmost === '(unknown)', `was ${userApp}, now ${nowFrontmost}`);

  // A restarted service remembers each chat's profile (the file is in the profile folder).
  await stopService(service);
  service = null;
  await waitFor(async () => !(await debugVersion(BASE_DEBUG_PORT)), 25_000);
  service = await startService({ OPENCHAMBER_CHROME_CLOSE_ON_STOP: '1' });
  state = await request('GET', '/state');
  const chatProfiles = Object.fromEntries((state.body?.chats ?? []).map((chat) => [chat.sessionId, chat.profile]));
  check(
    'chat choices survive a restart',
    chatProfiles[CHAT_A] === 'default' && chatProfiles[CHAT_B] === 'personal' && chatProfiles[CHAT_C] === 'work',
    JSON.stringify(chatProfiles),
  );

  // A relaunch: the default window is opened again by the restarted service. The
  // login from before must still be there, and the User-Agent must not have changed.
  const relaunchedOnce = await action(CHAT_A, 'browser.open', { url: `${base}relaunch` });
  const uaBefore = (await debugVersion(BASE_DEBUG_PORT))?.['User-Agent'] ?? null;
  const loginOnce = await action(CHAT_A, 'browser.snapshot', { tabId: relaunchedOnce.body?.data?.tabId, selector: '#cookie' });
  check('the login is still there after a relaunch', (loginOnce.body?.data?.text ?? '').includes('oc_test=kept'), JSON.stringify(loginOnce.body?.data?.text));

  await stopService(service);
  service = null;
  await waitFor(async () => !(await debugVersion(BASE_DEBUG_PORT)), 25_000);
  service = await startService({ OPENCHAMBER_CHROME_CLOSE_ON_STOP: '1' });
  const relaunchedTwice = await action(CHAT_A, 'browser.open', { url: `${base}relaunch` });
  const uaAfter = (await debugVersion(BASE_DEBUG_PORT))?.['User-Agent'] ?? null;
  check('the default profile keeps its User-Agent across relaunches', uaBefore !== null && uaAfter === uaBefore, `${uaBefore} vs ${uaAfter}`);
  const loginTwice = await action(CHAT_A, 'browser.snapshot', { tabId: relaunchedTwice.body?.data?.tabId, selector: '#cookie' });
  check('the login is still there after a second relaunch', (loginTwice.body?.data?.text ?? '').includes('oc_test=kept'), JSON.stringify(loginTwice.body?.data?.text));
} catch (error) {
  check('the sessions test completed', false, error instanceof Error ? error.stack : String(error));
} finally {
  await stopService(service);
  pageServer.close();
  spawn('/usr/bin/pkill', ['-f', `user-data-dir=${PROFILE}`]);
  await sleep(1_200);
  rmSync(PROFILE, { recursive: true, force: true });
  rmSync(READY_FILE, { force: true });
  console.log(`\n${failures === 0 ? 'all session checks passed' : `${failures} check(s) failed`}`);
  if (failures > 0) console.log(`\nservice output:\n${serviceLog.trim().split('\n').slice(-20).join('\n')}`);
  process.exit(failures > 0 ? 1 : 0);
}
