/**
 * Starting Chrome without taking over the screen.
 *
 * macOS activates an application the moment one of its windows opens, so a
 * Chrome started with a plain `spawn` jumps in front of whatever the user is
 * doing — every session, every time. Measured on this machine:
 *
 *   spawn        launch steals focus: yes | new tab steals: yes | bringToFront steals: yes
 *   open -g      launch steals focus: no  | new tab steals: no  | bringToFront steals: no
 *   offscreen    launch steals focus: yes | new tab steals: yes | bringToFront steals: yes
 *
 * `open -g` is therefore the default launcher on macOS: the window is a real
 * window (same rendering, same screenshot), it is simply never activated. That
 * includes the provider's own `bringToFront` when it switches tabs: activation
 * is a property of the launch, so nothing this service does can pull the
 * window in front of the user. To watch a profile's window, activate Chrome
 * yourself from the Dock.
 *
 * `spawn` stays available for Linux (no such activation problem) and for the
 * tests, and `OPENCHAMBER_CHROME_LAUNCHER` picks between them.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

import { CANDIDATE_BINARIES, CHROME_BUNDLE, CHROME_FOR_TESTING_BUNDLE, LAUNCHER, type ProfilePaths } from './env.ts';
import { describeError, exists, sleep } from './util.ts';

export type ChromeLaunchError = {
  /** `already-running`: a live Chrome on our profile; `not-found`: no binary. */
  kind: 'already-running' | 'not-found' | 'launch-failed';
  message: string;
};

export const resolveChromeExecutable = (): string | null =>
  CANDIDATE_BINARIES.find((candidate) => exists(candidate)) ?? null;

const CANDIDATE_BUNDLES: readonly string[] = [CHROME_FOR_TESTING_BUNDLE, CHROME_BUNDLE];

/** `/json/version` answers with the WebSocket URL while a debug port is live. */
export const probeDebugPort = async (port: number, timeoutMs = 1_500): Promise<string | null> => {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal: AbortSignal.timeout(timeoutMs) });
    if (!response.ok) return null;
    const body: unknown = await response.json();
    if (Object(body) !== body || body === null) return null;
    const url = (body as { webSocketDebuggerUrl?: unknown }).webSocketDebuggerUrl;
    return typeof url === 'string' && url.startsWith('ws://') ? url : null;
  } catch {
    return null;
  }
};

/** Chrome writes the port it bound here, at the user-data-dir root. */
export const readActivePort = (profile: string): number | null => {
  try {
    const raw = fs.readFileSync(path.join(profile, 'DevToolsActivePort'), 'utf8');
    const port = Number(raw.split('\n')[0]?.trim());
    return Number.isInteger(port) && port > 0 && port < 65536 ? port : null;
  } catch {
    return null;
  }
};

/** The pid listening on a debug port, which is one of Chrome's. */
export const portListenerPid = async (port: number): Promise<number | null> => {
  if (process.platform === 'win32') return null;
  const output = await new Promise<string>((resolve) => {
    const child = spawn('/usr/sbin/lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk;
    });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(text));
  });
  const pid = Number(output.trim().split('\n')[0]);
  return Number.isInteger(pid) && pid > 0 ? pid : null;
};

/**
 * Whether the Chrome answering a debug port was started on this profile, read
 * from that process's command line. Null when the owner cannot be inspected, so
 * nothing is claimed either way.
 */
export const listenerUsesProfile = async (port: number, profile: string): Promise<boolean | null> => {
  if (process.platform === 'win32') return null;
  const pid = await portListenerPid(port);
  if (pid === null) return null;
  const command = await new Promise<string>((resolve) => {
    const child = spawn('/bin/ps', ['-o', 'command=', '-p', String(pid)], { stdio: ['ignore', 'pipe', 'ignore'] });
    let text = '';
    child.stdout.on('data', (chunk) => {
      text += chunk;
    });
    child.on('error', () => resolve(''));
    child.on('close', () => resolve(text));
  });
  if (command.trim().length === 0) return null;
  return command.includes(`--user-data-dir=${profile}`);
};

/**
 * Starts Chrome on a profile and waits until it answers. The returned handle is
 * for closing it later; whether the process was ours to begin with is decided
 * by the caller, not here.
 */
export const launchChrome = async (options: {
  executablePath: string;
  paths: ProfilePaths;
  args: readonly string[];
}): Promise<{ pid: number | null; viaLauncher: boolean }> => {
  const { executablePath, paths, args } = options;
  const chromeArgs = [
    `--user-data-dir=${paths.profile}`,
    `--remote-debugging-port=${paths.port}`,
    ...args,
  ];

  fs.mkdirSync(paths.profile, { recursive: true });
  fs.mkdirSync(paths.downloads, { recursive: true });

  // A second Chrome on the same profile hands the URL to the first one and
  // exits without listening, which would look like a launch that hangs. That is
  // what the profile being open without a debug port looks like.
  const activePort = readActivePort(paths.profile);
  const profileLooksBusy =
    activePort !== null && activePort !== paths.port && (await probeDebugPort(activePort, 400)) === null;
  if (profileLooksBusy) {
    const message =
      `A Chrome window is already using this profile (${paths.profile}) without a reachable debug port. ` +
      'Close that window, then try again.';
    throw chromeError('already-running', message);
  }

  if (LAUNCHER === 'open') {
    const bundle = CANDIDATE_BUNDLES.find((candidate) => exists(candidate)) ?? CHROME_BUNDLE;
    const child = spawn('/usr/bin/open', ['-g', '-n', '-a', bundle, '--args', ...chromeArgs], {
      stdio: 'ignore',
      detached: true,
    });
    child.unref();
    // `open` exits once LaunchServices has the request; Chrome runs on without
    // us, which is the point. Its pid is found through the debug port later.
    return { pid: null, viaLauncher: true };
  }

  const child = spawn(executablePath, chromeArgs, { stdio: 'ignore', detached: true });
  child.unref();
  return { pid: typeof child.pid === 'number' ? child.pid : null, viaLauncher: false };
};

/** Waits for a launched Chrome to answer on its debug port. */
export const waitForDebugPort = async (port: number, timeoutMs = 25_000): Promise<string | null> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const url = await probeDebugPort(port, 700);
    if (url) return url;
    await sleep(150);
  }
  return null;
};

/** Signal 0 only asks whether the process exists. */
const isAlive = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * True once Chrome has quit: its debug port is silent and, when its pid is
 * known, the process itself is gone. Chrome writes its profile out as it exits.
 */
export const chromeExited = async (port: number, pid: number | null, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await probeDebugPort(port, 300)) === null && (pid === null || !isAlive(pid))) return true;
    await sleep(300);
  }
  return false;
};

/**
 * Asks Chrome on a debug port to quit, then insists. Returns true when the port
 * stops answering. `pid` is the process to signal when it is known: the browser
 * process group for a spawn, or the port's listener for `open`.
 */
export const quitChrome = async (port: number, pid: number | null, log: (message: string) => void): Promise<boolean> => {
  const target = pid ?? (await portListenerPid(port));
  if (target === null) {
    log('no Chrome process to close; leaving the window as it is');
    return false;
  }
  log(`asking Chrome (pid ${target}) to quit`);
  const signal = (name: NodeJS.Signals): void => {
    try {
      // A spawn made Chrome the leader of its own group, so the group is the
      // browser. `open` starts Chrome elsewhere, where only the pid is ours.
      process.kill(-target, name);
    } catch {
      try {
        process.kill(target, name);
      } catch {
        // Already gone.
      }
    }
  };
  signal('SIGTERM');
  // The port stops answering as shutdown begins, but Chrome writes its profile
  // (cookies included) only as it exits. Wait for the process itself, so the
  // next launch never reads a profile that is still being written.
  const deadline = Date.now() + 15_000;
  while (Date.now() < deadline) {
    if ((await probeDebugPort(port, 300)) === null && !isAlive(target)) return true;
    await sleep(300);
  }
  log('Chrome did not quit in time; forcing it');
  signal('SIGKILL');
  return (await probeDebugPort(port, 400)) === null;
};

export const chromeError = (kind: ChromeLaunchError['kind'], message: string): Error & ChromeLaunchError => {
  const error = new Error(message) as Error & ChromeLaunchError;
  error.kind = kind;
  return error;
};

export const isChromeLaunchError = (error: unknown): error is Error & ChromeLaunchError =>
  Object(error) === error && typeof (error as ChromeLaunchError).kind === 'string';
