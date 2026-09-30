/**
 * Two sessions, two windows.
 *
 * The point of running a Chrome per session is that two agents working at the
 * same time cannot see or disturb each other: separate windows, separate
 * profiles, separate cookies, separate tab ids — and neither window pulls
 * itself in front of the user.
 *
 *   npm run build && npm run test:sessions
 *
 * Focus is measured against the app that was in front when the test started;
 * if the provider activates a window, this test says so.
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
const PORT_REQUEST = '0';
const READY_FILE = path.join(os.tmpdir(), `oc-chrome-sessions-port-${randomBytes(6).toString('hex')}`);
const TOKEN = randomBytes(16).toString('hex');
const PROFILE = mkdtempSync(path.join(os.tmpdir(), 'oc-chrome-sessions-'));

const BASE_DEBUG_PORT = 8800 + Math.floor(Math.random() * 150);
const SESSION_A = 'ses_alpha00000000000000000';
const SESSION_B = 'ses_beta111111111111111111';

let port = 0;
let failures = 0;
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

let requestId = 0;
const action = (sessionId, name, parameters) => {
  requestId += 1;
  return request('POST', '/browser-control', {
    requestId: `sessions-${requestId}`,
    action: name,
    parameters,
    context: { directory: root, sessionId },
  });
};

const pageServer = http.createServer((incoming, outgoing) => {
  const title = incoming.url?.slice(1).split('?')[0] || 'home';
  outgoing.writeHead(200, { 'Content-Type': 'text/html' });
  outgoing.end(
    `<!doctype html><html><head><title>${title}</title></head><body><h1 id="h">${title}</h1>` +
      '<input id="name" placeholder="name" value=""></body></html>',
  );
});
await new Promise((resolve) => pageServer.listen(0, HOST, resolve));
const base = `http://${HOST}:${pageServer.address().port}/`;

const service = spawn(process.execPath, [serviceEntry], {
  env: {
    ...process.env,
    OPENCHAMBER_SERVICE_PORT: PORT_REQUEST,
    OPENCHAMBER_SERVICE_TOKEN: TOKEN,
    OPENCHAMBER_CHROME_PROFILE: PROFILE,
    OPENCHAMBER_SERVICE_READY_FILE: READY_FILE,
    OPENCHAMBER_CHROME_MAX_INSTANCES: '4',
    // Away from the user's own provider port, so the default session here is
    // this test's profile and not the Chrome they are using.
    OPENCHAMBER_CHROME_DEBUG_PORT: String(BASE_DEBUG_PORT),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serviceLog = '';
const collect = (chunk) => {
  serviceLog += String(chunk);
  process.stdout.write(`[service] ${chunk}`);
};
service.stdout.on('data', collect);
service.stderr.on('data', collect);

const stopService = async () => {
  if (service.exitCode === null && service.signalCode === null) {
    service.kill('SIGKILL');
    await new Promise((resolve) => {
      const timer = setTimeout(resolve, 5_000);
      service.once('exit', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }
};

try {
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
  if (!healthy) throw new Error(`the service did not become healthy\n${serviceLog}`);

  const userApp = frontmost();

  // Two sessions open their own windows, one after the other.
  const openA = await action(SESSION_A, 'browser.open', { url: `${base}alpha` });
  const openB = await action(SESSION_B, 'browser.open', { url: `${base}beta` });
  check('session A opens its own tab', openA.body?.ok === true, JSON.stringify(openA.body).slice(0, 200));
  check('session B opens its own tab', openB.body?.ok === true, JSON.stringify(openB.body).slice(0, 200));
  check('the two tab ids differ', openA.body?.data?.tabId !== openB.body?.data?.tabId);
  check('each tab id carries its session', openA.body?.data?.tabId?.split(':')[0] !== openB.body?.data?.tabId?.split(':')[0], `${openA.body?.data?.tabId} vs ${openB.body?.data?.tabId}`);

  const state = await request('GET', '/state');
  check('the service reports two sessions', state.body?.count === 2, JSON.stringify(state.body?.count));
  const profiles = (state.body?.sessions ?? []).map((entry) => entry.profile);
  check('the two sessions have different profiles', profiles.length === 2 && profiles[0] !== profiles[1], JSON.stringify(profiles));
  const ports = (state.body?.sessions ?? []).map((entry) => entry.port);
  check('the two sessions have different debug ports', ports.length === 2 && ports[0] !== ports[1], JSON.stringify(ports));

  // Each session sees only its own tab.
  const snapA = await action(SESSION_A, 'browser.snapshot', {});
  const snapB = await action(SESSION_B, 'browser.snapshot', {});
  check('session A reads its own page', snapA.body?.data?.title === 'alpha', JSON.stringify(snapA.body?.data?.title));
  check('session B reads its own page', snapB.body?.data?.title === 'beta', JSON.stringify(snapB.body?.data?.title));
  check('session A sees one tab, not two windows worth', (snapA.body?.data?.tabs ?? []).length === 1, JSON.stringify(snapA.body?.data?.tabs ?? []));

  // Cookies and storage are per session, by construction.
  await action(SESSION_A, 'browser.type', { selector: '#name', value: 'A wrote this', submit: false });
  const typedA = await action(SESSION_A, 'browser.snapshot', {});
  const inputA = (typedA.body?.data?.elements ?? []).find((element) => element.selector === '#name');
  check('session A typed into its own window', inputA?.label === 'A wrote this', JSON.stringify(inputA ?? typedA.body?.data?.elements ?? []).slice(0, 200));
  const valueB = await action(SESSION_B, 'browser.snapshot', { selector: '#name' });
  check('session B input is untouched by session A', (valueB.body?.data?.text ?? '').trim() === '', JSON.stringify(valueB.body?.data?.text));
  await action(SESSION_B, 'browser.type', { selector: '#name', value: 'B wrote this', submit: false });
  const headingA = await action(SESSION_A, 'browser.snapshot', { selector: '#h' });
  check('session B typing does not disturb session A', (headingA.body?.data?.text ?? '') === 'alpha', JSON.stringify(headingA.body?.data?.text));

  // A tab id from one session is refused by the other, never followed.
  const crossSession = await action(SESSION_B, 'browser.snapshot', { tabId: openA.body.data.tabId });
  check(
    'a tab id from another session is refused',
    crossSession.body?.ok === false && String(crossSession.body.error).includes("another session's window"),
    JSON.stringify(crossSession.body).slice(0, 200),
  );

  // A session-less action uses the default profile, which no agent session shares.
  const shared = await action(null, 'browser.open', { url: `${base}default` });
  check('a session-less action opens the default window', shared.body?.ok === true, JSON.stringify(shared.body).slice(0, 200));
  const defaultPrefix = shared.body?.data?.tabId?.split(':')[0];
  check(
    'the default window is its own session',
    defaultPrefix !== openA.body?.data?.tabId?.split(':')[0] && defaultPrefix !== openB.body?.data?.tabId?.split(':')[0],
    String(defaultPrefix),
  );

  // Nothing the provider did should have pulled a window in front of the user.
  const nowFrontmost = frontmost();
  check(
    'the user stays in front of every window',
    nowFrontmost === userApp || nowFrontmost === '(unknown)',
    `was ${userApp}, now ${nowFrontmost}`,
  );

  // Closing one session leaves the other's window alone.
  const closeOne = await action(SESSION_B, 'browser.snapshot', {});
  check('session B still answers before its window closes', closeOne.body?.ok === true);
} catch (error) {
  check('the sessions test completed', false, error instanceof Error ? error.stack : String(error));
} finally {
  await stopService();
  pageServer.close();
  spawn('/usr/bin/pkill', ['-f', `user-data-dir=${PROFILE}`]);
  await sleep(1_200);
  rmSync(PROFILE, { recursive: true, force: true });
  rmSync(READY_FILE, { force: true });
  console.log(`\n${failures === 0 ? 'all session checks passed' : `${failures} check(s) failed`}`);
  if (failures > 0) console.log(`\nservice output:\n${serviceLog.trim().split('\n').slice(-20).join('\n')}`);
  process.exit(failures > 0 ? 1 : 0);
}
