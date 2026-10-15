/**
 * The reconnect path: Chrome outlives the service.
 *
 * The host stops an idle provider after ten minutes, but the Chrome window it
 * started keeps running. The next action must attach to that window, not open
 * a second one on the same profile (which Chrome answers by handing the URL to
 * the first window and never listening on our port).
 *
 *   node scripts/test-reconnect.mjs
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceEntry = path.join(root, 'service', 'main.cjs');
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

const HOST = '127.0.0.1';
/** The service's own port; Chrome's debug port is a separate, random one. */
const PORT = 9900 + Math.floor(Math.random() * 60);
/** Random, so this test never shares a debug port with a provider the user is running. */
const DEBUG_PORT = 9700 + Math.floor(Math.random() * 90);
const TOKEN = randomBytes(16).toString('hex');
const PROFILE = mkdtempSync(path.join(os.tmpdir(), 'oc-chrome-reconnect-'));

let failures = 0;
const check = (name, ok, detail) => {
  if (!ok) failures += 1;
  console.log(`${ok ? 'ok  ' : 'FAIL'} ${name}${ok || detail === undefined ? '' : `\n      ${detail}`}`);
};

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (probe, timeoutMs = 25_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await probe()) return true;
    await sleep(250);
  }
  return false;
};

const probeDebugPort = async () => {
  try {
    const response = await fetch(`http://${HOST}:${DEBUG_PORT}/json/version`, { signal: AbortSignal.timeout(1_000) });
    return response.ok;
  } catch {
    return false;
  }
};

const countChromeProcesses = () => {
  const result = spawn('/usr/bin/pgrep', ['-f', `user-data-dir=${PROFILE}`]);
  return new Promise((resolve) => {
    let output = '';
    result.stdout.on('data', (chunk) => {
      output += chunk;
    });
    result.on('close', () => resolve(output.trim().split('\n').filter((line) => line.length > 0).length));
  });
};

const request = (method, route, body) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const call = http.request(
      {
        host: HOST,
        port: PORT,
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

const startService = () => {
  const child = spawn(process.execPath, [serviceEntry], {
    env: {
      ...process.env,
      OPENCHAMBER_SERVICE_PORT: String(PORT),
      OPENCHAMBER_SERVICE_TOKEN: TOKEN,
      OPENCHAMBER_CHROME_PROFILE: PROFILE,
      OPENCHAMBER_CHROME_DEBUG_PORT: String(DEBUG_PORT),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  child.stdout.on('data', (chunk) => process.stdout.write(`[service] ${chunk}`));
  child.stderr.on('data', (chunk) => process.stdout.write(`[service] ${chunk}`));
  return child;
};

const stop = async (child) => {
  if (child.exitCode !== null || child.signalCode !== null) return;
  child.kill('SIGTERM');
  await new Promise((resolve) => {
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      resolve(undefined);
    }, 8_000);
    child.once('exit', () => {
      clearTimeout(timer);
      resolve(undefined);
    });
  });
};

let chrome;
let service;
try {
  // 1. A Chrome window that the provider did not start: launched by hand on
  //    the provider's own profile and debug port.
  chrome = spawn(
    CHROME,
    // The default profile's folder: the service attaches only to a Chrome whose
    // profile folder reports the port it is on.
    [`--user-data-dir=${path.join(PROFILE, 'chrome')}`, `--remote-debugging-port=${DEBUG_PORT}`, '--no-first-run', '--no-default-browser-check', 'about:blank'],
    { stdio: 'ignore', detached: false },
  );
  check('a Chrome window is listening on the provider port', await waitFor(probeDebugPort), `port ${DEBUG_PORT}`);

  // 2. The service starts and must attach, not launch.
  service = startService();
  check('the service becomes healthy', await waitFor(async () => {
    try {
      const response = await request('GET', '/health');
      return response.status === 200;
    } catch {
      return false;
    }
  }));

  const snapshot = await action('browser.snapshot', {});
  check('an action is answered from the running Chrome', snapshot.body?.ok === true, JSON.stringify(snapshot.body).slice(0, 300));
  check('the answer names a tab in that window', typeof snapshot.body?.data?.tabs?.[0]?.id === 'string');

  const state = await request('GET', '/state');
  const session = (state.body?.profiles ?? []).find((entry) => entry.name === 'default') ?? {};
  check('the service reports a ready Chrome', session.chrome === 'ready', JSON.stringify(state.body).slice(0, 240));
  check(
    'the service says it reconnected',
    (session.log ?? []).some((line) => line.includes('reconnecting')),
    JSON.stringify(session.log ?? []).slice(0, 300),
  );

  // 3. Exactly one Chrome: attaching must not have opened a second window.
  const before = await countChromeProcesses();
  const opened = await action('browser.open', { url: 'https://example.com' }, 'open-after-reconnect');
  const after = await countChromeProcesses();
  check('browser.open works after reconnecting', opened.body?.ok === true, JSON.stringify(opened.body).slice(0, 300));
  check('the second window count is unchanged', after <= before + 1 && after > 0, `before ${before}, after ${after}`);

  await stop(service);
  service = undefined;
  await sleep(1_000);
  check('Chrome survives the service being stopped', await probeDebugPort());
} catch (error) {
  check('the reconnect test completed', false, error instanceof Error ? error.stack : String(error));
} finally {
  if (service) await stop(service);
  if (chrome && chrome.exitCode === null) chrome.kill('SIGTERM');
  await sleep(1_500);
  spawn('/usr/bin/pkill', ['-f', `user-data-dir=${PROFILE}`]);
  await sleep(900);
  rmSync(PROFILE, { recursive: true, force: true });
  console.log(`\n${failures === 0 ? 'all reconnect checks passed' : `${failures} check(s) failed`}`);
  process.exit(failures > 0 ? 1 : 0);
}
