/**
 * Environment and paths the host controls, plus where this provider keeps its
 * Chrome profiles and caches.
 *
 * The host sets OPENCHAMBER_SERVICE_PORT and OPENCHAMBER_SERVICE_TOKEN and
 * nothing else; every path below has a sane default so the provider can also
 * be run by hand (see scripts/test-provider.mjs).
 *
 * Layout, so a session profile is never nested inside another profile:
 *
 *   ~/OpenChamberChromeProfile/            the base directory
 *   ├── chrome/                            the default window's Chrome profile
 *   ├── downloads/                         the default window's downloads
 *   └── sessions/<name>/chrome/            one profile per agent session
 */
import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

export const SERVICE_PORT: number | null = (() => {
  const raw = Number(process.env.OPENCHAMBER_SERVICE_PORT);
  // 0 asks the OS for a free port; tests use it so they never collide with a
  // provider the user is running. The bound port reaches them via the ready file.
  return Number.isInteger(raw) && raw >= 0 && raw < 65536 ? raw : null;
})();

export const SERVICE_TOKEN: string = process.env.OPENCHAMBER_SERVICE_TOKEN ?? '';

/** True when the host launched us; used only for a friendlier startup error. */
export const HOSTED: boolean = SERVICE_PORT !== null && SERVICE_TOKEN.length > 0;

/** The extension folder, one level above the built bundle in service/. */
export const EXTENSION_ROOT = path.resolve(__dirname, '..');

const BASE_DIR = process.env.OPENCHAMBER_CHROME_PROFILE ?? path.join(os.homedir(), 'OpenChamberChromeProfile');

export const CHROME_STABLE = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
export const CHROME_BUNDLE = '/Applications/Google Chrome.app';
export const CHROME_FOR_TESTING = '/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing';
export const CHROME_FOR_TESTING_BUNDLE = '/Applications/Google Chrome for Testing.app';

/** Override with OPENCHAMBER_CHROME_BIN; Chrome for Testing wins when installed. */
export const CANDIDATE_BINARIES: readonly string[] = [
  process.env.OPENCHAMBER_CHROME_BIN ?? '',
  CHROME_FOR_TESTING,
  CHROME_STABLE,
].filter((candidate) => candidate.length > 0);

/**
 * The launcher used to start Chrome. `open -g` is the default because macOS
 * otherwise activates the app the moment a window opens, pulling it in front
 * of whatever the user is doing; `-g` opens it without activating, while the
 * window still renders for real and answers every action. `spawn` is for
 * Linux, where activation is not the issue, and for tests.
 */
export const LAUNCHER = process.env.OPENCHAMBER_CHROME_LAUNCHER ?? (process.platform === 'darwin' ? 'open' : 'spawn');

const DEBUG_PORT_BASE = (() => {
  const raw = Number(process.env.OPENCHAMBER_CHROME_DEBUG_PORT);
  return Number.isInteger(raw) && raw > 0 && raw < 60000 ? raw : 9223;
})();

/** How many providers may run at once before the least recently used one is closed. */
export const MAX_INSTANCES = (() => {
  const raw = Number(process.env.OPENCHAMBER_CHROME_MAX_INSTANCES);
  return Number.isInteger(raw) && raw > 0 && raw <= 64 ? raw : 8;
})();

/** How long an untouched instance is kept before its window is closed. */
export const INSTANCE_IDLE_MS = (() => {
  const raw = Number(process.env.OPENCHAMBER_CHROME_IDLE_MS);
  return Number.isInteger(raw) && raw >= 30_000 ? raw : 12 * 60_000;
})();

/**
 * `visible` (the default) is a real window that never activates itself; see
 * launcher.ts for why that needs `open -g`. `headless` runs Chrome with no
 * window at all: same rendering, same screenshots, nothing on screen to watch
 * or step into.
 */
export const WINDOW_MODE: 'visible' | 'headless' =
  process.env.OPENCHAMBER_CHROME_HEADLESS === '1' ? 'headless' : 'visible';

export type SessionPaths = {
  /** Enough of the session id to read in a path, plus a hash so it is unique. */
  name: string;
  directory: string;
  profile: string;
  downloads: string;
  port: number;
};

/**
 * Where a session's Chrome lives. One profile per session means one cookie jar
 * per session: two agents signed into the same site do not fight over it, and
 * neither sees the other's session. A null session id (a CLI call) keeps the
 * long-standing single profile, so an existing install keeps its logins.
 */
export const sessionPaths = (sessionId: string | null): SessionPaths => {
  if (sessionId === null) {
    return {
      name: 'default',
      directory: BASE_DIR,
      profile: path.join(BASE_DIR, 'chrome'),
      downloads: path.join(BASE_DIR, 'downloads'),
      port: DEBUG_PORT_BASE,
    };
  }
  const readable = sessionId.replace(/[^A-Za-z0-9_-]/g, '').slice(-24) || 'session';
  const hash = crypto.createHash('sha256').update(sessionId).digest('hex').slice(0, 6);
  const name = `${readable}-${hash}`;
  const directory = path.join(BASE_DIR, 'sessions', name);
  return {
    name,
    directory,
    profile: path.join(directory, 'chrome'),
    downloads: path.join(directory, 'downloads'),
    // Deterministic and stable across restarts, so a surviving window is found
    // again on the port it is already listening on.
    port: DEBUG_PORT_BASE + 1 + (Number.parseInt(hash, 16) % 500),
  };
};

export const BASE_PROFILE_DIR = BASE_DIR;

/** How long `browser.open` waits for the `load` event before answering `settled: false`. */
export const SETTLE_TIMEOUT_MS = 12_000;

/** Ceilings, so a huge page cannot blow past the host's 20s / 12MB answer limits. */
export const SNAPSHOT_TEXT_MAX = 60_000;
export const SNAPSHOT_ELEMENTS_MAX = 250;
export const CONSOLE_PROBLEMS_MAX = 50;

/** `fill` has no intrinsic size; this is what it settles on in a headed window. */
export const DEFAULT_VIEWPORT = { width: 1280, height: 800 };
