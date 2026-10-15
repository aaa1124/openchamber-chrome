/**
 * The provider must never bring a window to the front.
 *
 * This measures the only thing that matters to a person working on their
 * machine: whatever app is in front stays in front across the provider's
 * actions. It does not assume which app that is — the machine may be in use
 * while this runs, and a test that insists on Finder is a test that fails when
 * the user opens a chat window.
 *
 * Nothing but HTTP is in the loop: no app, no UI, no tool call. If an action
 * changes the frontmost app to Google Chrome, the provider moved a window.
 *
 *   npm run test:focus
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

const PORT_REQUEST = '0';
const READY_FILE = path.join(os.tmpdir(), `oc-focus-port-${randomBytes(6).toString('hex')}`);
const TOKEN = randomBytes(16).toString('hex');
const PROFILE = mkdtempSync(path.join(os.tmpdir(), 'oc-focus-run-'));
/** Far below the provider's own ports (9223 and up), so a window the user is running cannot share a port with this test. */
const DEBUG_BASE = 7000 + Math.floor(Math.random() * 100);

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

const request = (method, route, body) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const call = http.request(
      {
        host: '127.0.0.1',
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
    requestId: `focus-${requestId}`,
    action: name,
    parameters,
    context: { directory: root, sessionId },
  });
};

/**
 * Runs an action and reports whether the app in front survived it.
 *
 * The check that matters is narrow and objective: the provider's windows must
 * never become the frontmost app. A machine in use can change the frontmost app
 * by itself (a chat window opening, for example), so a change is only a failure
 * when the app that arrived is Chrome; anything else is reported and not blamed.
 */
const staysInBackground = async (label, run) => {
  const before = frontmost();
  const result = await run();
  await sleep(1_500);
  const after = frontmost();
  const quiet = after === before;
  const providerMoved = after === 'Google Chrome' && before !== 'Google Chrome';
  if (!quiet) {
    console.log(`      note: frontmost changed from ${before} to ${after} during this step`);
  }
  check(label, !providerMoved, `was ${before}, now ${after}`);
  return { result, quiet, providerMoved };
};

const service = spawn(process.execPath, [serviceEntry], {
  env: {
    ...process.env,
    OPENCHAMBER_SERVICE_PORT: PORT_REQUEST,
    OPENCHAMBER_SERVICE_TOKEN: TOKEN,
    OPENCHAMBER_CHROME_PROFILE: PROFILE,
    OPENCHAMBER_SERVICE_READY_FILE: READY_FILE,
    OPENCHAMBER_CHROME_DEBUG_PORT: String(DEBUG_BASE),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
service.stdout.on('data', (chunk) => process.stdout.write(`[service] ${chunk}`));
service.stderr.on('data', (chunk) => process.stdout.write(`[service] ${chunk}`));

try {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline && port === 0) {
    try {
      port = Number(readFileSync(READY_FILE, 'utf8').trim());
    } catch {
      await sleep(200);
    }
  }
  check('the service is up', port > 0, `port ${port}`);

  // A port already answering would mean this test is about to drive someone
  // else's browser, which would make every focus result meaningless.
  const stranger = await fetch(`http://127.0.0.1:${DEBUG_BASE}/json/version`).then((response) => response.ok, () => false);
  check('the test has the debug ports to itself', !stranger, `something already listens on ${DEBUG_BASE}`);

  const SESSION_A = 'ses_focus0000000000000000000';
  const SESSION_B = 'ses_other11111111111111111111';
  // Chat B is pointed at the work profile, so the two chats open two windows.
  await request('POST', '/chat-profile', { sessionId: SESSION_B, profile: 'work' });

  const opened = await staysInBackground('starting a window does not come to the front', () =>
    action(SESSION_A, 'browser.open', { url: 'https://example.com' }),
  );
  await staysInBackground('a snapshot does not come to the front', () => action(SESSION_A, 'browser.snapshot', {}));
  const second = await staysInBackground('a second session does not come to the front', () =>
    action(SESSION_B, 'browser.open', { url: 'https://example.com' }),
  );

  check('both sessions got their own tab', opened.result.body?.ok === true && second.result.body?.ok === true);
  const state = await request('GET', '/state');
  const openWindows = (state.body?.profiles ?? []).filter((entry) => entry.chrome !== 'stopped').length;
  check('two profile windows are open', openWindows === 2, JSON.stringify((state.body?.profiles ?? []).map((entry) => [entry.name, entry.chrome])));
} catch (error) {
  check('the focus test completed', false, error instanceof Error ? error.stack : String(error));
} finally {
  if (service.exitCode === null) service.kill('SIGKILL');
  spawn('/usr/bin/pkill', ['-f', `user-data-dir=${PROFILE}`]);
  await sleep(1_200);
  rmSync(PROFILE, { recursive: true, force: true });
  rmSync(READY_FILE, { force: true });
  console.log(`\n${failures === 0 ? 'all focus checks passed' : `${failures} check(s) failed`}`);
  process.exit(failures > 0 ? 1 : 0);
}
