/**
 * One Chrome window, for one agent session.
 *
 * The service holds one driver per session id (see sessions.ts). Each driver
 * owns exactly one window on its own profile and debug port, so two sessions
 * cannot see each other's tabs, cookies or logins, and neither can disturb the
 * other's page.
 *
 * The window outlives this service: the host stops an idle service, and a
 * session's window — a login, a half-filled form, twenty tabs — is still there
 * when the next action arrives, because it is started by `open -g` rather than
 * as a child of anything here (see launcher.ts). That launcher choice is also
 * what keeps the window from jumping in front of the user.
 *
 * Chrome reports every page as visible and focused while a CDP client is
 * attached, so "the tab the user sees" cannot be read from the page. It is
 * tracked instead from what this provider did: the tab it opened last, or the
 * one it was told to bring to the front.
 */
import fsp from 'node:fs/promises';
import path from 'node:path';
import { chromium, type Browser, type BrowserContext, type Page } from 'playwright-core';

import { WINDOW_MODE, type SessionPaths } from './env.ts';
import {
  chromeError,
  launchChrome,
  probeDebugPort,
  quitChrome,
  resolveChromeExecutable,
  waitForDebugPort,
} from './launcher.ts';
import { describeError, sleep } from './util.ts';

/**
 * Chrome's own flags. The window is started as an ordinary browser process, so
 * nothing else gets to add its own.
 */
const CHROME_ARGS = [
  '--no-first-run',
  '--no-default-browser-check',
  '--remote-allow-origins=*',
  '--disable-features=Translate,OptimizationHints,MediaRouter',
  '--disable-session-crashed-bubble',
  '--hide-crash-restore-bubble',
  '--password-store=basic',
  '--use-mock-keychain',
] as const;

/** `--headless=new` renders for real; it just has no window to show. */
const HEADLESS_ARGS = ['--headless=new', '--hide-scrollbars', '--mute-audio'] as const;

export type ChromeState = 'stopped' | 'starting' | 'ready' | 'failed';

/** Pages that exist only because nothing has opened yet. */
const BLANK_URLS = ['about:blank', 'chrome://newtab/', 'chrome://new-tab-page/', 'chrome://welcome/'] as const;

export type DriverStatus = {
  session: string;
  chrome: ChromeState;
  connected: boolean;
  executable: string | null;
  profile: string;
  port: number;
  pages: number;
  lastError: string | null;
};

const isDisconnected = (error: unknown): boolean => {
  const text = describeError(error).toLowerCase();
  return text.includes('closed') || text.includes('disconnected') || text.includes('target page, context or browser');
};

export class ChromeDriver {
  readonly session: string;
  readonly paths: SessionPaths;

  #browser: Browser | null = null;
  #context: BrowserContext | null = null;
  #executable: string | null = null;
  #state: ChromeState = 'stopped';
  #lastError: string | null = null;
  #starting: Promise<void> | null = null;
  #lastActivated: Page | null = null;
  /** The Chrome this service started, when it started one. */
  #chromePid: number | null = null;
  #targetIds = new WeakMap<Page, string>();
  #cdpSessions = new WeakMap<Page, Promise<string>>();
  #eventLog: string[] = [];
  #closed = false;
  #lastUsed = Date.now();

  constructor(session: string, paths: SessionPaths) {
    this.session = session;
    this.paths = paths;
  }

  get state(): ChromeState {
    return this.#state;
  }

  get lastError(): string | null {
    return this.#lastError;
  }

  /** Minutes since the last action that touched this instance. */
  get idleMs(): number {
    return Date.now() - this.#lastUsed;
  }

  touch(): void {
    this.#lastUsed = Date.now();
  }

  status(): DriverStatus {
    return {
      session: this.session,
      chrome: this.#state,
      connected: this.#context !== null,
      executable: this.#executable ?? resolveChromeExecutable(),
      profile: this.paths.profile,
      port: this.paths.port,
      pages: this.#context ? this.pages().length : 0,
      lastError: this.#lastError,
    };
  }

  /** Lifecycle notes; the panel shows the last few and nothing else reads them. */
  log(message: string): void {
    this.#eventLog.push(`${new Date().toISOString()} ${message}`);
    if (this.#eventLog.length > 50) this.#eventLog.shift();
    console.error(`[openchamber-chrome] [${this.session}] ${message}`);
  }

  recentLog(): string[] {
    return [...this.#eventLog];
  }

  /** Starts this session's Chrome if needed. Concurrent callers share one start. */
  async ensureStarted(): Promise<void> {
    this.touch();
    if (this.#closed) throw new Error('This browser session is shutting down.');
    if (this.#context && this.#browser?.isConnected()) return;
    if (this.#context) {
      this.#context = null;
      this.#browser = null;
      this.#state = 'stopped';
    }
    if (!this.#starting) {
      this.#starting = this.#start().finally(() => {
        this.#starting = null;
      });
    }
    await this.#starting;
  }

  async #start(): Promise<void> {
    this.#state = 'starting';
    this.#executable = resolveChromeExecutable();
    if (!this.#executable) {
      this.#state = 'failed';
      this.#lastError = 'Google Chrome was not found in /Applications.';
      throw chromeError('not-found', this.#lastError);
    }

    // A window that outlived the previous service is adopted rather than
    // duplicated: it is already listening on this session's port.
    const existing = await probeDebugPort(this.paths.port);
    if (existing) {
      this.log(`reconnecting to the Chrome already listening on ${this.paths.port}`);
      await this.#attach(existing);
      return;
    }

    this.log(`launching Chrome from ${this.#executable} on port ${this.paths.port} (${WINDOW_MODE})`);
    const handle = await launchChrome({
      executablePath: this.#executable,
      paths: this.paths,
      args: [
        ...CHROME_ARGS,
        ...(WINDOW_MODE === 'headless' ? HEADLESS_ARGS : ['--window-size=1280,900']),
      ],
    });
    this.#chromePid = handle.pid;

    const webSocketDebuggerUrl = await waitForDebugPort(this.paths.port);
    if (!webSocketDebuggerUrl) {
      this.#state = 'failed';
      this.#lastError = 'Chrome did not open its debug port. See the extension panel log for what Chrome said.';
      throw chromeError('launch-failed', this.#lastError);
    }
    await this.#attach(webSocketDebuggerUrl);
  }

  async #attach(webSocketDebuggerUrl: string): Promise<void> {
    const browser = await chromium.connectOverCDP(webSocketDebuggerUrl);
    this.#browser = browser;
    const context = browser.contexts()[0];
    if (!context) {
      await browser.close().catch(() => undefined);
      this.#browser = null;
      this.#state = 'failed';
      this.#lastError = 'Chrome answered, but reported no browser context.';
      throw chromeError('launch-failed', this.#lastError);
    }
    this.#observe(browser, context);
    this.log(`attached to Chrome with ${context.pages().length} page(s)`);
  }

  #observe(browser: Browser, context: BrowserContext): void {
    this.#browser = browser;
    this.#context = context;
    this.#state = 'ready';
    this.#lastError = null;

    browser.on('disconnected', () => {
      if (this.#closed) return;
      this.log('Chrome disconnected');
      this.#browser = null;
      this.#context = null;
      this.#lastActivated = null;
      this.#state = 'stopped';
    });

    const register = (page: Page): void => {
      page.on('dialog', (dialog) => {
        this.log(`dismissed a ${dialog.type()} dialog`);
        void dialog.dismiss().catch(() => undefined);
      });
      page.on('download', (download) => {
        const target = path.join(this.paths.downloads, download.suggestedFilename());
        void fsp
          .mkdir(path.dirname(target), { recursive: true })
          .then(() => download.saveAs(target))
          .then(() => this.log(`saved download ${download.suggestedFilename()}`))
          .catch((error: unknown) => this.log(`download failed: ${describeError(error)}`));
      });
    };

    for (const page of context.pages()) register(page);
    context.on('page', (page) => {
      register(page);
      // Chrome makes a new tab active, so it is what the user sees until
      // something else is brought forward.
      this.#lastActivated = page;
    });
  }

  /** Every open tab, in the order Chrome lists them. */
  pages(): Page[] {
    if (!this.#context) return [];
    return this.#context.pages().filter((page) => !page.isClosed());
  }

  /** Marks a page as the visible one; every action that fronts a page calls this. */
  markActivated(page: Page): void {
    this.#lastActivated = page;
  }

  /** The tab the user sees: whatever was activated last, else the newest. */
  async activePage(): Promise<Page | null> {
    const pages = this.pages();
    if (pages.length === 0) return null;
    if (this.#lastActivated && !this.#lastActivated.isClosed() && pages.includes(this.#lastActivated)) {
      return this.#lastActivated;
    }
    return pages[pages.length - 1] as Page;
  }

  /** The CDP target id of a page, which the agent's `tabId` is built from. */
  async targetId(page: Page): Promise<string> {
    const cached = this.#targetIds.get(page);
    if (cached) return cached;
    let pending = this.#cdpSessions.get(page);
    if (!pending) {
      pending = (async () => {
        const session = await page.context().newCDPSession(page);
        const info = (await session.send('Target.getTargetInfo')) as {
          targetInfo?: { targetId?: unknown };
        };
        const targetId = info.targetInfo?.targetId;
        if (typeof targetId !== 'string' || targetId.length === 0) throw new Error('Chrome did not name the tab');
        this.#targetIds.set(page, targetId);
        return targetId;
      })();
      this.#cdpSessions.set(page, pending);
    }
    return pending.catch((error: unknown) => {
      this.#cdpSessions.delete(page);
      throw error;
    });
  }

  /** Resolves a bare target id to a live page, or says it is gone. */
  async resolvePage(targetId: string | undefined): Promise<Page> {
    this.touch();
    const context = await this.context();
    const pages = this.pages();
    if (pages.length === 0) {
      const page = await context.newPage();
      await page.goto('about:blank').catch(() => undefined);
      this.markActivated(page);
      return page;
    }
    if (!targetId) {
      const active = await this.activePage();
      return active ?? (pages[pages.length - 1] as Page);
    }
    for (const page of pages) {
      if ((await this.targetId(page)) === targetId) return page;
    }
    throw new Error(
      `Tab ${targetId} is no longer open. Take a snapshot to list the open tabs, then use one of those ids.`,
    );
  }

  /** Resolves once Chrome is up, then hands back its context. */
  async context(): Promise<BrowserContext> {
    await this.ensureStarted();
    if (!this.#context) throw new Error('Chrome is not running');
    return this.#context;
  }

  /** Opens a tab without stealing the user's page, and answers its target id. */
  async openTab(url: string): Promise<{ page: Page; targetId: string }> {
    const context = await this.context();
    const previous = await this.activePage();
    const page = await context.newPage();
    this.markActivated(page);
    try {
      await page.goto(url, { waitUntil: 'commit', timeout: 30_000 });
    } catch (error) {
      // The tab still exists with Chrome's own error page; say so rather than
      // closing it, so the agent can retry a corrected URL.
      this.log(`opening ${url} failed: ${describeError(error)}`);
    }
    await this.#retireBlankDoor(context, previous, page);
    if (previous && !previous.isClosed() && previous !== page) {
      await previous.bringToFront().catch(() => undefined);
      this.markActivated(previous);
    }
    return { page, targetId: await this.targetId(page) };
  }

  /**
   * Chrome opens with one empty page. Leaving it means the agent works in a
   * background tab while the user looks at an empty window, so the untouched
   * empty page is retired once a real one exists. A page that has navigated
   * anywhere is never touched.
   */
  async #retireBlankDoor(context: BrowserContext, previous: Page | null, opened: Page): Promise<void> {
    if (!previous || previous === opened || previous.isClosed()) return;
    if (context.pages().filter((page) => !page.isClosed()).length < 2) return;
    if (!BLANK_URLS.includes(previous.url() as (typeof BLANK_URLS)[number])) return;
    await previous.close().catch(() => undefined);
    this.log('closed the empty starting tab');
  }

  /** Brings a page forward inside this window, and remembers it. */
  async front(page: Page): Promise<void> {
    await page.bringToFront().catch(() => undefined);
    this.markActivated(page);
  }

  /** Waits for the `load` event; a timeout means "still loading", not failure. */
  async waitForSettle(page: Page, timeoutMs: number): Promise<boolean> {
    if (page.isClosed()) return true;
    try {
      await page.waitForLoadState('load', { timeout: timeoutMs });
      return true;
    } catch {
      return false;
    }
  }

  viewportOf(page: Page): { mode: 'custom'; width: number | null; height: number | null } {
    const size = page.viewportSize();
    return {
      mode: 'custom',
      width: size?.width ?? 1280,
      height: size?.height ?? 800,
    };
  }

  /**
   * Ends this session: the CDP client disconnects. With `hard`, a Chrome this
   * session is responsible for is asked to quit as well.
   */
  async close(hard = false): Promise<void> {
    this.#closed = true;
    const context = this.#context;
    const browser = this.#browser;
    const pid = this.#chromePid;
    this.#context = null;
    this.#browser = null;
    this.#lastActivated = null;
    this.#chromePid = null;
    this.#state = 'stopped';

    try {
      await Promise.race([browser?.close() ?? context?.close() ?? Promise.resolve(), sleep(4_000)]);
    } catch (error) {
      this.log(`detaching from Chrome failed: ${describeError(error)}`);
    }
    if (!hard) return;
    const closed = await quitChrome(this.paths.port, pid, (message: string) => this.log(message));
    if (!closed) {
      // Nothing was listening: no window of ours to close.
      this.log('no window to close for this session');
    }
  }
}
