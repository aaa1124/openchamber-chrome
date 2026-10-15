/**
 * The provider's own acceptance test, run against a real Chrome with no
 * OpenChamber in the loop: it starts the built service the way the host does,
 * then drives every `browser.*` action over loopback and checks the answers.
 *
 *   npm run build && npm test
 *
 * Uses a throwaway profile under the system temp directory unless
 * OPENCHAMBER_TEST_PROFILE is set, so a normal install is never touched.
 */
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';
import { chromium } from 'playwright-core';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const serviceEntry = path.join(root, 'service', 'main.cjs');

const HOST = '127.0.0.1';
const PORT = 9400 + Math.floor(Math.random() * 300);
/** Random, so this test never fights a provider the user is running for the same port. */
const DEBUG_PORT = 9200 + Math.floor(Math.random() * 200);
const TOKEN = randomBytes(16).toString('hex');
const PROFILE = process.env.OPENCHAMBER_TEST_PROFILE ?? mkdtempSync(path.join(os.tmpdir(), 'oc-chrome-test-'));

const results = [];
let failures = 0;

const check = (name, condition, detail) => {
  results.push({ name, ok: Boolean(condition), detail });
  if (!condition) failures += 1;
  const mark = condition ? 'ok  ' : 'FAIL';
  console.log(`${mark} ${name}${condition || detail === undefined ? '' : `\n      ${detail}`}`);
};

const request = (method, route, body, token = TOKEN) =>
  new Promise((resolve, reject) => {
    const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));
    const call = http.request(
      {
        host: HOST,
        port: PORT,
        method,
        path: route,
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
      },
      (response) => {
        let text = '';
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => {
          let parsed = null;
          try {
            parsed = text ? JSON.parse(text) : null;
          } catch {
            parsed = text;
          }
          resolve({ status: response.statusCode, body: parsed, raw: text });
        });
      },
    );
    call.on('error', reject);
    if (payload) call.write(payload);
    call.end();
  });

let requestId = 0;
/** One session id for the main run; tab ids are minted against it. */
const SESSION = 'ses_testprovider000000000000';
const action = async (name, parameters, options = {}) => {
  requestId += 1;
  return request(
    'POST',
    '/browser-control',
    {
      requestId: `test-${requestId}`,
      action: name,
      parameters,
      context: { directory: root, sessionId: options.session === undefined ? SESSION : options.session },
    },
    options.token,
  );
};

const waitForHealth = async (timeoutMs = 20_000) => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const response = await request('GET', '/health');
      if (response.status === 200) return true;
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  return false;
};

const service = spawn(process.execPath, [serviceEntry], {
  env: {
    ...process.env,
    OPENCHAMBER_SERVICE_PORT: String(PORT),
    OPENCHAMBER_SERVICE_TOKEN: TOKEN,
    OPENCHAMBER_CHROME_PROFILE: PROFILE,
    OPENCHAMBER_CHROME_DEBUG_PORT: String(DEBUG_PORT),
  },
  stdio: ['ignore', 'pipe', 'pipe'],
});
let serviceLog = '';
service.stdout.on('data', (chunk) => {
  serviceLog += chunk;
});
service.stderr.on('data', (chunk) => {
  serviceLog += chunk;
});

const stopService = async () => {
  if (service.exitCode === null && service.signalCode === null) {
    service.kill('SIGTERM');
    await new Promise((resolve) => {
      const timer = setTimeout(() => {
        service.kill('SIGKILL');
        resolve(undefined);
      }, 8_000);
      service.once('exit', () => {
        clearTimeout(timer);
        resolve(undefined);
      });
    });
  }
  // The window outlives the service by design; a test must still take it down.
  await new Promise((resolve) => {
    const killer = spawn('/usr/bin/pkill', ['-f', `user-data-dir=${PROFILE}`]);
    killer.on('close', resolve);
    killer.on('error', resolve);
  });
  await new Promise((resolve) => setTimeout(resolve, 700));
};

const testPage = `<!doctype html>
<html><head><title>Provider test page</title></head>
<body style="font:16px system-ui; padding:24px">
  <h1 id="heading">Provider test</h1>
  <p>Some text the snapshot should read.</p>
  <label for="name">Name</label>
  <input id="name" name="name" placeholder="Your name" />
  <label for="fruit">Fruit</label>
  <select id="fruit"><option value="apple">Apple</option><option value="pear">Pear</option></select>
  <button id="save" onclick="document.getElementById('saved').textContent='Saved ' + document.getElementById('name').value">Save</button>
  <a id="about" href="/about">About</a>
  <div style="height:1600px">tall</div>
  <p id="saved"></p>
</body></html>`;

const aboutPage = '<!doctype html><html><head><title>About</title></head><body><h1 id="about-heading">About</h1></body></html>';

const pageServer = http.createServer((incoming, outgoing) => {
  if (incoming.url?.startsWith('/about')) {
    outgoing.writeHead(200, { 'Content-Type': 'text/html' });
    outgoing.end(aboutPage);
    return;
  }
  outgoing.writeHead(200, { 'Content-Type': 'text/html' });
  outgoing.end(testPage);
});

const pagePort = await new Promise((resolve) => {
  pageServer.listen(0, HOST, () => resolve(pageServer.address().port));
});
const pageUrl = `http://${HOST}:${pagePort}/`;

const main = async () => {
  if (!(await waitForHealth())) {
    check('service becomes healthy', false, serviceLog.trim() || 'no output');
    return;
  }
  check('service becomes healthy', true);

  const unauthorized = await request('GET', '/health', undefined, 'wrong-token');
  check('health refuses a wrong token', unauthorized.status === 401, `status ${unauthorized.status}`);

  const malformed = await request('POST', '/browser-control', { nope: true });
  check('a malformed action answers 400', malformed.status === 400, JSON.stringify(malformed.body));

  const opened = await action('browser.open', { url: pageUrl });
  check('browser.open opens a background tab', opened.body?.ok === true && typeof opened.body.data?.tabId === 'string', JSON.stringify(opened.body).slice(0, 300));
  check('the tab id names its profile', /^[0-9a-f]{6}:[0-9A-F]{32}$/.test(opened.body?.data?.tabId ?? ''), opened.body?.data?.tabId);
  const tabId = opened.body?.data?.tabId;

  const settled = await action('browser.open', { url: pageUrl });
  check('browser.open reports settled', settled.body?.data?.settled === true, JSON.stringify(settled.body?.data ?? {}).slice(0, 200));

  const snapshot = await action('browser.snapshot', { tabId });
  const data = snapshot.body?.data ?? {};
  check('browser.snapshot reads the page', snapshot.body?.ok === true && data.title === 'Provider test page', data.title);
  check('browser.snapshot lists tabs', Array.isArray(data.tabs) && data.tabs.length >= 1 && data.tabs.some((tab) => tab.id === tabId), JSON.stringify(data.tabs ?? []).slice(0, 300));
  check('browser.snapshot finds the button', (data.elements ?? []).some((element) => element.selector === '#save' && element.tag === 'button'), JSON.stringify(data.elements ?? []).slice(0, 300));
  check('browser.snapshot finds the input', (data.elements ?? []).some((element) => element.selector === '#name'), JSON.stringify((data.elements ?? []).map((e) => e.selector)));
  check('browser.snapshot reports scroll', data.scrollY === 0 && data.maxScrollY > 500, `scrollY ${data.scrollY} maxScrollY ${data.maxScrollY}`);
  check('browser.snapshot counts elements', typeof data.interactiveElementsOnPage === 'number' && data.interactiveElementsOnPage >= 3, String(data.interactiveElementsOnPage));

  const typed = await action('browser.type', { selector: '#name', value: 'Ada', submit: false, tabId });
  check('browser.type fills a field', typed.body?.ok === true, JSON.stringify(typed.body).slice(0, 200));

  const clicked = await action('browser.click', { selector: '#save', tabId });
  check('browser.click clicks a button', clicked.body?.ok === true && clicked.body.data?.clicked === '#save', JSON.stringify(clicked.body).slice(0, 200));

  const afterClick = await action('browser.snapshot', { tabId, selector: '#saved' });
  check('the click ran the page script', (afterClick.body?.data?.text ?? '').includes('Saved Ada'), afterClick.body?.data?.text);

  const clickedText = await action('browser.click', { text: 'About', tabId });
  check('browser.click matches by text', clickedText.body?.ok === true, JSON.stringify(clickedText.body).slice(0, 200));
  await new Promise((resolve) => setTimeout(resolve, 500));

  const back = await action('browser.back', { tabId });
  check('browser.back goes back', back.body?.ok === true && back.body.data?.url === pageUrl, JSON.stringify(back.body).slice(0, 200));

  const forward = await action('browser.forward', { tabId });
  check('browser.forward goes forward', forward.body?.ok === true && forward.body.data?.url?.startsWith(pageUrl), JSON.stringify(forward.body).slice(0, 200));
  await action('browser.back', { tabId });

  const scrolled = await action('browser.scroll', { direction: 'bottom', tabId });
  check('browser.scroll( bottom ) reaches the end', scrolled.body?.ok === true && scrolled.body.data?.atBottom === true, JSON.stringify(scrolled.body?.data));
  const up = await action('browser.scroll', { direction: 'top', tabId });
  check('browser.scroll( top ) returns to the start', up.body?.data?.atTop === true && up.body.data.scrollY === 0, JSON.stringify(up.body?.data));

  const inspected = await action('browser.inspect', { selector: '#heading', tabId });
  check('browser.inspect returns styles', inspected.body?.ok === true && inspected.body.data?.tag === 'h1' && typeof inspected.body.data.styles?.['font-size'] === 'string', JSON.stringify(inspected.body).slice(0, 300));

  const resized = await action('browser.resize', { viewport: 'mobile', tabId });
  check('browser.resize applies a viewport', resized.body?.data?.viewport?.width === 390, JSON.stringify(resized.body?.data));

  const captured = await action('browser.capture', { tabId });
  const image = captured.body?.data ?? {};
  check('browser.capture returns an image', captured.body?.ok === true && typeof image.base64 === 'string' && image.base64.length > 1000, `mime ${image.mime} size ${image.base64?.length}`);
  check('browser.capture reports the resized viewport', image.width === 390, `${image.width}x${image.height}`);

  const unknownTab = await action('browser.snapshot', { tabId: `${String(tabId).split(':')[0]}:not-a-tab` });
  check('an unknown tab id is refused', unknownTab.body?.ok === false && String(unknownTab.body.error).includes('no longer open'), JSON.stringify(unknownTab.body));

  const secondTab = await action('browser.open', { url: `${pageUrl}about` });
  check('a second tab opens', secondTab.body?.ok === true && secondTab.body.data.tabId !== tabId, JSON.stringify(secondTab.body?.data ?? {}).slice(0, 200));
  const tabsSnapshot = await action('browser.snapshot', { tabId });
  check('the snapshot lists both tabs', (tabsSnapshot.body?.data?.tabs ?? []).length >= 2, JSON.stringify(tabsSnapshot.body?.data?.tabs ?? []).slice(0, 400));

  const badSelector = await action('browser.click', { selector: '#does-not-exist', tabId });
  check('a missing element explains itself', badSelector.body?.ok === false && String(badSelector.body.error).includes('Could not click'), JSON.stringify(badSelector.body).slice(0, 240));

  const state = await request('GET', '/state');
  const mainSession = (state.body?.profiles ?? []).find((entry) => entry.name === 'default') ?? {};
  check(
    'the panel state reads the default profile',
    (state.body?.profiles ?? []).length === 3 && mainSession.chrome === 'ready' && mainSession.pages >= 2,
    JSON.stringify(state.body).slice(0, 240),
  );

  // The User-Agent has to be Chrome's own: any `--user-agent` override empties
  // the high-entropy client hints, which stock Chrome never does (see
  // src/launcher.ts). Read both straight from the running window.
  const versionBody = await fetch(`http://${HOST}:${mainSession.port}/json/version`)
    .then((response) => response.json())
    .catch(() => null);
  const realVersion = typeof versionBody?.Browser === 'string' ? versionBody.Browser.replace(/^Chrome\//, '') : null;
  const realMajor = typeof realVersion === 'string' ? realVersion.split('.')[0] : null;

  const cdp = await chromium.connectOverCDP(`http://${HOST}:${mainSession.port}`);
  const cdpPages = cdp.contexts()[0]?.pages() ?? [];
  const probePage = cdpPages.find((candidate) => candidate.url().startsWith(pageUrl)) ?? cdpPages[0] ?? null;
  const fingerprint = probePage
    ? await probePage.evaluate(async () => {
        const uad = navigator.userAgentData;
        const high = uad ? await uad.getHighEntropyValues(['uaFullVersion', 'fullVersionList']) : null;
        return {
          userAgent: navigator.userAgent,
          uaFullVersion: high?.uaFullVersion ?? null,
          fullVersionList: high?.fullVersionList ?? [],
        };
      })
    : null;

  check(
    'the User-Agent matches the running Chrome build',
    Boolean(realMajor) && fingerprint !== null && fingerprint.userAgent.includes(`Chrome/${realMajor}.0.0.0`),
    `UA ${fingerprint?.userAgent ?? '(none)'} for Chrome/${realVersion ?? '(unknown)'}`,
  );
  check(
    'client hints report the running Chrome build',
    fingerprint?.uaFullVersion === realVersion && fingerprint.fullVersionList.length > 0,
    `uaFullVersion ${fingerprint?.uaFullVersion ?? '(none)'} fullVersionList ${JSON.stringify(fingerprint?.fullVersionList ?? [])}`,
  );
};

try {
  await main();
} catch (error) {
  check('the test run completed', false, error instanceof Error ? error.stack : String(error));
} finally {
  await stopService();
  pageServer.close();
  if (!process.env.OPENCHAMBER_TEST_PROFILE) rmSync(PROFILE, { recursive: true, force: true });
  console.log(`\n${results.length - failures}/${results.length} checks passed`);
  if (failures > 0 && serviceLog.trim()) console.log(`\nservice output:\n${serviceLog.trim().split('\n').slice(-25).join('\n')}`);
  process.exit(failures > 0 ? 1 : 0);
}
