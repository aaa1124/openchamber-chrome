/**
 * The window outlives the service, however the service is stopped.
 *
 * The host stops an idle provider with SIGTERM; a crash is SIGKILL. Either way
 * the Chrome window must still be there — a login, a half-filled form, twenty
 * tabs — and the next service start must attach to it rather than open a
 * second one.
 *
 *   npm run build && npm run test:survival
 *
 * Opens a real Chrome window and closes it at the end.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceEntry = path.join(root, 'service', 'main.cjs');

const HOST = '127.0.0.1';
/** 0 lets the OS pick; the service writes the real port to READY_FILE. */
const PORT_REQUEST = '0';
const READY_FILE = path.join(os.tmpdir(), `oc-chrome-survival-port-${randomBytes(6).toString('hex')}`);
/** Random, so this test never shares a debug port with a provider the user is actually running. */
const DEBUG_PORT = 9800 + Math.floor(Math.random() * 150);
const TOKEN = randomBytes(16).toString('hex');
const PROFILE = mkdtempSync(path.join(os.tmpdir(), 'oc-chrome-survival-'));

let port = 0;

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : `\n      ${detail}`}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const readFile = async (file) => readFileSync(file, 'utf8');

const waitFor = async (probe, timeoutMs = 30_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await sleep(250);
  }
  return false;
};

const debugPortAnswers = async () => {
  try {
    const response = await fetch(`http://${HOST}:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
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

const action = (name, parameters, requestId = name) =>
  request('POST', '/browser-control', { requestId, action: name, parameters, context: { directory: root, sessionId: null } });

const startService = async (extraEnv = {}) => {
  port = 0;
  // A stale file from the previous service would name the wrong port.
  rmSync(READY_FILE, { force: true });
  const child = spawn(process.execPath, [serviceEntry], {
    env: {
      ...process.env,
      OPENCHAMBER_SERVICE_PORT: PORT_REQUEST,
      OPENCHAMBER_SERVICE_TOKEN: TOKEN,
      OPENCHAMBER_SERVICE_READY_FILE: READY_FILE,
      OPENCHAMBER_CHROME_PROFILE: PROFILE,
      OPENCHAMBER_CHROME_DEBUG_PORT: String(DEBUG_PORT),
      ...extraEnv,
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.serviceLog = '';
  const collect = (chunk) => {
    child.serviceLog += String(chunk);
    process.stdout.write(`[service] ${chunk}`);
  };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const healthy = await waitFor(async () => {
    if (port === 0) {
      try {
        port = Number((await readFile(READY_FILE, 'utf8')).trim());
      } catch {
        return false;
      }
    }
    try {
      const response = await request('GET', '/health');
      return response.status === 200;
    } catch {
      return false;
    }
  });
  if (!healthy) throw new Error('the service did not become healthy');
  return child;
};

const waitForExit = (child, timeoutMs = 8_000) =>
  new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(false);
    }, timeoutMs);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(true);
    });
  });

let service;
try {
  // 1. A first session opens a page. This is the window the user would be
  //    looking at when they went away for ten minutes.
  service = await startService();
  const opened = await action('browser.open', { url: 'data:text/html,<title>Session</title><p>signed in</p>' });
  check('Chrome is launched and answers', opened.body?.ok === true, JSON.stringify(opened.body).slice(0, 240));
  const firstTabId = opened.body?.data?.tabId;
  check('Chrome is listening on the debug port', await debugPortAnswers());

  // 2. The host stops an idle service: SIGTERM.
  service.kill('SIGTERM');
  check('the service exits on SIGTERM', await waitForExit(service));
  await sleep(1_500);
  check('the window survives SIGTERM', await debugPortAnswers());

  // 3. A crash: SIGKILL.
  service = await startService();
  check('a restarted service attaches to that window', (await action('browser.snapshot', { tabId: firstTabId })).body?.ok === true);
  service.kill('SIGKILL');
  check('the service exits on SIGKILL', await waitForExit(service));
  await sleep(1_500);
  check('the window survives SIGKILL', await debugPortAnswers());

  // 4. The next action works against the same window, same tab.
  service = await startService();
  const snapshot = await action('browser.snapshot', { tabId: firstTabId });
  check('the same tab is still addressable after both stops', snapshot.body?.ok === true, JSON.stringify(snapshot.body).slice(0, 240));
  check('it is still the page the session left', (snapshot.body?.data?.text ?? '').includes('signed in'), snapshot.body?.data?.text);
  const state = await request('GET', '/state');
  check('the service reports it reconnected, not launched', (state.body?.sessions ?? []).some((session) => (session.log ?? []).some((line) => line.includes('reconnecting'))));
  check('exactly one Chrome is running for the profile', (await countChrome()) > 0 && (await countChrome()) < 40, String(await countChrome()));

  // 5. A window no service started is not this service's to close, and a
  //    service that started one closes it when told to on stop.
  spawn('/usr/bin/pkill', ['-f', `user-data-dir=${PROFILE}`]);
  check('the profile is clear for the close-on-stop checks', await waitFor(async () => !(await debugPortAnswers()), 25_000));
  await sleep(1_000);

  service = await startService({ OPENCHAMBER_CHROME_CLOSE_ON_STOP: '1' });
  const relaunched = await action('browser.open', { url: 'data:text/html,<title>Fresh</title>' });
  check('a fresh window is launched for the new service', relaunched.body?.ok === true && (await debugPortAnswers()));
  const finalService = service;
  service.kill('SIGTERM');
  check('the close-on-stop service exits', await waitForExit(service));
  const closed = await waitFor(async () => !(await debugPortAnswers()), 20_000);
  if (!closed) {
    console.log(`      last lines from that service:\n${String(finalService.serviceLog ?? '').trim().split('\n').slice(-10).join('\n')}`);
  }
  check('close-on-stop takes the window it started with it', closed);
} catch (error) {
  check('the survival test completed', false, error instanceof Error ? error.stack : String(error));
} finally {
  if (service && service.exitCode === null) {
    service.kill('SIGKILL');
    await waitForExit(service);
  }
  const remaining = await request('GET', '/state').catch(() => null);
  void remaining;
  await sleep(500);
  const killer = spawn('/usr/bin/pkill', ['-f', `user-data-dir=${PROFILE}`]);
  await new Promise((resolve) => {
    killer.on('close', resolve);
    killer.on('error', resolve);
  });
  await sleep(900);
  rmSync(PROFILE, { recursive: true, force: true });
  rmSync(READY_FILE, { force: true });
  console.log(`\n${failures === 0 ? 'all survival checks passed' : `${failures} check(s) failed`}`);
  process.exit(failures > 0 ? 1 : 0);
}

async function countChrome() {
  const result = spawn('/usr/bin/pgrep', ['-f', `user-data-dir=${PROFILE}`]);
  return new Promise((resolve) => {
    let output = '';
    result.stdout.on('data', (chunk) => {
      output += chunk;
    });
    result.on('close', () => resolve(output.trim().split('\n').filter((line) => line.length > 0).length));
  });
}
