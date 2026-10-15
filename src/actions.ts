/**
 * The ten `browser.*` actions, answered from a real Chrome.
 *
 * Every answer is the shape the desktop app's own browser panel answers with,
 * so an agent prompt written against either works. Errors say what to do
 * differently, because the agent reads them.
 *
 * Tabs belong to a profile. The provider mints a tab id as `<hash of the
 * profile>:<target>` and refuses a tab id minted for another profile, so two
 * profiles cannot act on each other's pages even if an id is copied between them.
 */
import type { Page } from 'playwright-core';
import { createHash } from 'node:crypto';

import type { BrowserProviderRequest, BrowserProviderResult, BrowserTab } from '@openchamber/sdk';
import { CONSOLE_PROBLEMS_MAX, SETTLE_TIMEOUT_MS } from './env.ts';
import { ChromeDriver } from './driver.ts';
import { readHistoryState, readSnapshot, readScrollState, snapshotScopeOptions, type SnapshotDom } from './snapshot.ts';
import { clamp, describeError, isUsableSelector, sleep } from './util.ts';

const CLICK_TIMEOUT_MS = 12_000;
const ACTION_TIMEOUT_MS = 15_000;
/** Screenshots above this switch to JPEG, so the host's 12MB answer ceiling holds. */
const CAPTURE_PNG_MAX_BYTES = 2_500_000;

const VIEWPORTS = {
  mobile: { width: 390, height: 844 },
  tablet: { width: 820, height: 1180 },
  desktop: { width: 1280, height: 800 },
} as const;

const INSPECT_PROPERTIES = [
  'display',
  'position',
  'color',
  'background-color',
  'font-family',
  'font-size',
  'font-weight',
  'line-height',
  'margin',
  'padding',
  'border',
  'border-radius',
  'width',
  'height',
  'opacity',
  'visibility',
  'overflow',
  'text-align',
] as const;

type ConsoleProblem = { level: 'warning' | 'error'; message: string; source: string };

/** Console warnings and errors are kept per page and read once, by the next snapshot. */
const consoleProblems = new WeakMap<Page, ConsoleProblem[]>();

const watchConsole = (page: Page): void => {
  if (consoleProblems.has(page)) return;
  const problems: ConsoleProblem[] = [];
  consoleProblems.set(page, problems);
  page.on('console', (message) => {
    const type = message.type();
    if (type !== 'warning' && type !== 'error') return;
    problems.push({ level: type, message: message.text().slice(0, 500), source: 'page console' });
    if (problems.length > CONSOLE_PROBLEMS_MAX) problems.shift();
  });
  page.on('pageerror', (error) => {
    problems.push({ level: 'error', message: describeError(error).slice(0, 500), source: 'uncaught exception' });
    if (problems.length > CONSOLE_PROBLEMS_MAX) problems.shift();
  });
};

const watchConsoleSafely = (page: Page): void => {
  try {
    watchConsole(page);
  } catch {
    // A page that closed while being registered needs no listener.
  }
};

/**
 * The injected readers are authored functions: Playwright serializes them, so
 * they run in the page with only DOM globals. Passing a function (rather than a
 * string built at runtime) is what keeps page data out of code.
 */
const snapshotPage = async (page: Page, selector: string | undefined): Promise<SnapshotDom | null> =>
  page.evaluate(readSnapshot, snapshotScopeOptions(selector));

const scrollState = async (page: Page): Promise<{ scrollY: number; maxScrollY: number }> =>
  page.evaluate(readScrollState);

/** One profile's window, plus the tab-id naming this provider puts on it. */
class Session {
  readonly key: string;
  readonly prefix: string;
  readonly #driver: ChromeDriver;

  constructor(key: string, driver: ChromeDriver) {
    this.key = key;
    this.#driver = driver;
    // A short opaque prefix, so a tab id reads cleanly and two profiles cannot
    // mint the same one: `a1b2c3:4AC85E5B…`.
    this.prefix = `${createHash('sha256').update(key).digest('hex').slice(0, 6)}:`;
  }

  /**
   * The tab an action names. A `tabId` without this profile's prefix belongs to
   * another profile's window and is refused rather than followed; without a `tabId`
   * the tab that was activated last answers.
   */
  async resolve(tabId: string | undefined): Promise<{ page: Page; driver: ChromeDriver }> {
    return { page: await this.#driver.resolvePage(this.#bareTarget(tabId)), driver: this.#driver };
  }

  /** How a tab id leaves this provider: prefixed, so another session cannot claim it. */
  mint(targetId: string): string {
    return `${this.prefix}${targetId}`;
  }

  async page(): Promise<Page> {
    return (await this.resolve(undefined)).page;
  }

  #bareTarget(tabId: string | undefined): string | undefined {
    if (tabId === undefined) return undefined;
    if (!tabId.startsWith(this.prefix)) {
      throw new Error(
        `Tab ${tabId} belongs to another profile's window. Take a snapshot here to list this profile's tabs, then use one of those ids.`,
      );
    }
    return tabId.slice(this.prefix.length);
  }
}

const tabsOf = async (session: Session, driver: ChromeDriver): Promise<BrowserTab[]> => {
  const active = await driver.activePage();
  const tabs: BrowserTab[] = [];
  for (const page of driver.pages()) {
    try {
      tabs.push({
        id: session.mint(await driver.targetId(page)),
        title: await page.title().catch(() => ''),
        url: page.url(),
        active: page === active,
      });
    } catch {
      // A page that closed between listing and naming is simply not listed.
    }
  }
  return tabs;
};

const nearbyCandidates = async (page: Page): Promise<string> => {
  const payload = await snapshotPage(page, undefined).catch(() => null);
  if (!payload) return '';
  const names = payload.elements
    .slice(0, 8)
    .map((element) => element.label ?? element.selector)
    .filter((name) => name.length > 0);
  return names.length > 0 ? ` Closest matches on the page: ${names.join(', ')}.` : '';
};

/** One sentence, no doubled period when the underlying error already ends in one. */
const asSentence = (error: unknown): string => describeError(error).replace(/\.+$/, '');

const handleOpen = async (
  session: Session,
  parameters: Extract<BrowserProviderRequest, { action: 'browser.open' }>['parameters'],
): Promise<BrowserProviderResult> => {
  if (parameters.tabId !== undefined) {
    const { page, driver } = await session.resolve(parameters.tabId);
    try {
      await page.goto(parameters.url, { waitUntil: 'commit', timeout: 30_000 });
    } catch (error) {
      return { ok: false, error: `Chrome could not load ${parameters.url}: ${asSentence(error)}.` };
    }
    await driver.front(page);
    const settled = await driver.waitForSettle(page, SETTLE_TIMEOUT_MS);
    return {
      ok: true,
      data: {
        tabId: session.mint(await driver.targetId(page)),
        url: page.url(),
        title: await page.title().catch(() => ''),
        opened: true,
        settled,
        viewport: driver.viewportOf(page),
      },
    };
  }

  const driver = (await session.resolve(undefined)).driver;
  const opened = await driver.openTab(parameters.url);
  const settled = await driver.waitForSettle(opened.page, SETTLE_TIMEOUT_MS);
  return {
    ok: true,
    data: {
      tabId: session.mint(opened.targetId),
      url: opened.page.url(),
      title: await opened.page.title().catch(() => ''),
      opened: true,
      settled,
      viewport: driver.viewportOf(opened.page),
    },
  };
};

const handleSnapshot = async (
  session: Session,
  parameters: Extract<BrowserProviderRequest, { action: 'browser.snapshot' }>['parameters'],
): Promise<BrowserProviderResult> => {
  const { page, driver } = await session.resolve(parameters.tabId);
  watchConsoleSafely(page);
  const payload = await snapshotPage(page, parameters.selector);
  if (!payload) {
    return {
      ok: false,
      error: `Nothing matches ${parameters.selector}. Omit the selector to read the whole page.`,
    };
  }
  const problems = consoleProblems.get(page) ?? [];
  consoleProblems.set(page, []);
  const data: Record<string, unknown> = {
    url: payload.url,
    title: payload.title,
    scope: parameters.selector ?? 'document',
    scrollY: 0,
    maxScrollY: 0,
    text: payload.text,
    elements: payload.elements,
    viewport: driver.viewportOf(page),
  };
  if (payload.textTotalChars > payload.text.length) {
    data.textTruncated = true;
    data.textTotalChars = payload.textTotalChars;
  }
  if (payload.interactiveTotal > payload.elements.length) data.elementsTruncated = true;
  if (payload.interactiveTotal > 0) data.interactiveElementsOnPage = payload.interactiveTotal;
  if (problems.length > 0) data.consoleProblems = problems;
  const tabs = await tabsOf(session, driver).catch(() => []);
  if (tabs.length > 0) data.tabs = tabs;
  if (!parameters.selector) {
    try {
      const metrics = await scrollState(page);
      data.scrollY = metrics.scrollY;
      data.maxScrollY = metrics.maxScrollY;
    } catch {
      // A page that navigated mid-read just reports zero here.
    }
  }
  return { ok: true, data } as BrowserProviderResult;
};

const handleClick = async (
  session: Session,
  parameters: Extract<BrowserProviderRequest, { action: 'browser.click' }>['parameters'],
): Promise<BrowserProviderResult> => {
  const { page } = await session.resolve(parameters.tabId);
  const selector = parameters.selector;
  const text = parameters.text;
  if (selector && !isUsableSelector(selector)) {
    return {
      ok: false,
      error: `${selector} is not a usable selector. Use a CSS selector such as #save, or a text match instead.`,
    };
  }
  if (!selector && !text) {
    return { ok: false, error: 'browser.click needs selector or text.' };
  }

  let label = text ?? selector ?? '';
  try {
    if (selector) {
      const locator = page.locator(selector).first();
      await locator.click({ timeout: CLICK_TIMEOUT_MS });
      const elementText = await locator.textContent({ timeout: 1_000 }).catch(() => null);
      label = elementText?.trim().slice(0, 80) || label;
    } else if (text) {
      const locator = page
        .locator(
          'button, a, [role="button"], [role="link"], [role="menuitem"], [role="tab"], input[type="submit"], input[type="button"], label',
          { hasText: text },
        )
        .first();
      await locator.click({ timeout: CLICK_TIMEOUT_MS });
    }
  } catch (error) {
    const candidates = selector ? await nearbyCandidates(page) : '';
    const said = asSentence(error);
    return {
      ok: false,
      error: `Could not click ${selector ?? `"${text ?? ''}"`}: ${said}.${candidates}`,
    };
  }
  return { ok: true, data: { clicked: selector ?? `text=${text ?? ''}`, label, url: page.url() } };
};

const describeField = async (page: Page, selector: string): Promise<{ tag: string; type: string } | null> => {
  try {
    return (await page.evaluate((target: string) => {
      const node = document.querySelector(target);
      if (!node || !(node instanceof HTMLElement)) return null;
      return { tag: node.tagName.toLowerCase(), type: (node.getAttribute('type') ?? '').toLowerCase() };
    }, selector)) as { tag: string; type: string } | null;
  } catch {
    return null;
  }
};

const handleType = async (
  session: Session,
  parameters: Extract<BrowserProviderRequest, { action: 'browser.type' }>['parameters'],
): Promise<BrowserProviderResult> => {
  const { page } = await session.resolve(parameters.tabId);
  const { selector, value } = parameters;
  if (!isUsableSelector(selector)) return { ok: false, error: `${selector} is not a usable selector.` };
  const field = await describeField(page, selector);
  if (!field) {
    const candidates = await nearbyCandidates(page);
    return { ok: false, error: `No field matches ${selector}.${candidates}` };
  }
  const locator = page.locator(selector).first();
  try {
    if (field.tag === 'select') {
      try {
        await locator.selectOption(value, { timeout: ACTION_TIMEOUT_MS });
      } catch {
        await locator.selectOption({ label: value }, { timeout: ACTION_TIMEOUT_MS });
      }
    } else if (field.tag === 'input' || field.tag === 'textarea') {
      await locator.fill(value, { timeout: ACTION_TIMEOUT_MS });
    } else {
      await locator.click({ timeout: ACTION_TIMEOUT_MS });
      await page.keyboard.type(value);
    }
    if (parameters.submit) await page.keyboard.press('Enter');
  } catch (error) {
    return { ok: false, error: `Could not type into ${selector}: ${asSentence(error)}.` };
  }
  return { ok: true, data: { selector, url: page.url() } };
};

const handleScroll = async (
  session: Session,
  parameters: Extract<BrowserProviderRequest, { action: 'browser.scroll' }>['parameters'],
): Promise<BrowserProviderResult> => {
  const { page } = await session.resolve(parameters.tabId);
  const direction = parameters.direction;
  const selector = parameters.selector;
  if (selector) {
    if (!isUsableSelector(selector)) return { ok: false, error: `${selector} is not a usable selector.` };
    const locator = page.locator(selector).first();
    try {
      await locator.scrollIntoViewIfNeeded({ timeout: ACTION_TIMEOUT_MS });
    } catch (error) {
      return { ok: false, error: `Could not scroll to ${selector}: ${asSentence(error)}.` };
    }
  } else {
    await page.evaluate((where: string) => {
      if (where === 'top') window.scrollTo({ top: 0, behavior: 'instant' });
      else if (where === 'bottom') window.scrollTo({ top: document.documentElement.scrollHeight, behavior: 'instant' });
      else if (where === 'up') window.scrollBy({ top: -Math.round(window.innerHeight * 0.85), behavior: 'instant' });
      else window.scrollBy({ top: Math.round(window.innerHeight * 0.85), behavior: 'instant' });
    }, direction ?? 'down');
  }
  await page.waitForTimeout(120);
  const metrics = await scrollState(page);
  const data: Record<string, unknown> = {
    scrollY: metrics.scrollY,
    maxScrollY: metrics.maxScrollY,
    atTop: metrics.scrollY <= 0,
    atBottom: metrics.maxScrollY - metrics.scrollY <= 2,
  };
  if (selector) data.scrolledTo = selector;
  else if (direction) data.direction = direction;
  return { ok: true, data } as BrowserProviderResult;
};

const handleHistory = async (
  session: Session,
  parameters: Extract<BrowserProviderRequest, { action: 'browser.back' | 'browser.forward' }>['parameters'],
  action: 'back' | 'forward',
): Promise<BrowserProviderResult> => {
  const { page, driver } = await session.resolve(parameters.tabId);
  const suggestion = ' Take a snapshot to see where the tab is, then open the page you want.';

  // Chrome blocks history traversal for a moment after the last navigation, so
  // the tab is asked what it can do rather than guessed at.
  const deadline = Date.now() + 3_000;
  let state = await page.evaluate(readHistoryState).catch(() => null);
  while (state && action === 'back' && !state.canGoBack && Date.now() < deadline) {
    await sleep(120);
    state = await page.evaluate(readHistoryState).catch(() => null);
  }
  while (state && action === 'forward' && !state.canGoForward && Date.now() < deadline) {
    await sleep(120);
    state = await page.evaluate(readHistoryState).catch(() => null);
  }
  const allowed = state ? (action === 'back' ? state.canGoBack : state.canGoForward) : true;
  if (!allowed) {
    return { ok: false, error: `There is nothing to go ${action} to in this tab.${suggestion}` };
  }

  try {
    const previousUrl = page.url();
    await page.evaluate((step: string) => {
      if (step === 'back') window.history.back();
      else window.history.forward();
    }, action);
    await page
      .waitForURL((next) => next.href !== previousUrl, { timeout: 8_000, waitUntil: 'commit' })
      .catch(() => undefined);
  } catch (error) {
    return { ok: false, error: `Could not go ${action}: ${asSentence(error)}.${suggestion}` };
  }
  await driver.waitForSettle(page, 5_000);
  return { ok: true, data: { url: page.url(), title: await page.title().catch(() => '') } };
};

const handleInspect = async (
  session: Session,
  parameters: Extract<BrowserProviderRequest, { action: 'browser.inspect' }>['parameters'],
): Promise<BrowserProviderResult> => {
  const { page } = await session.resolve(parameters.tabId);
  const selector = parameters.selector;
  if (!isUsableSelector(selector)) return { ok: false, error: `${selector} is not a usable selector.` };
  const locator = page.locator(selector).first();
  try {
    const details = (await locator.evaluate(
      (node: Element, properties: string[]) => {
        const rect = node.getBoundingClientRect();
        const computed = getComputedStyle(node);
        const styles: Record<string, string> = {};
        for (const property of properties) styles[property] = computed.getPropertyValue(property);
        const text = (node.textContent ?? '').replace(/\s+/g, ' ').trim().slice(0, 120);
        return {
          tag: node.tagName.toLowerCase(),
          label: text || node.getAttribute('aria-label') || node.getAttribute('placeholder') || '',
          bounds: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
          inViewport: rect.bottom > 0 && rect.right > 0 && rect.top < window.innerHeight && rect.left < window.innerWidth,
          styles,
        };
      },
      [...INSPECT_PROPERTIES],
      { timeout: ACTION_TIMEOUT_MS },
    )) as {
      tag: string;
      label: string;
      bounds: { x: number; y: number; width: number; height: number };
      inViewport: boolean;
      styles: Record<string, string>;
    };
    return { ok: true, data: { selector, ...details } };
  } catch (error) {
    const candidates = await nearbyCandidates(page);
    return { ok: false, error: `No element matches ${selector}: ${asSentence(error)}.${candidates}` };
  }
};

const handleCapture = async (
  session: Session,
  parameters: Extract<BrowserProviderRequest, { action: 'browser.capture' }>['parameters'],
): Promise<BrowserProviderResult> => {
  const { page, driver } = await session.resolve(parameters.tabId);
  const viewport = driver.viewportOf(page);
  const width = viewport.width ?? 1280;
  const height = viewport.height ?? 800;
  const buffer = await page.screenshot({ type: 'png', timeout: ACTION_TIMEOUT_MS, animations: 'disabled' });
  const title = await page.title().catch(() => '');
  if (buffer.length > CAPTURE_PNG_MAX_BYTES) {
    const jpeg = await page.screenshot({ type: 'jpeg', quality: 82, timeout: ACTION_TIMEOUT_MS, animations: 'disabled' });
    return {
      ok: true,
      data: { base64: jpeg.toString('base64'), mime: 'image/jpeg', width, height, url: page.url(), title, viewport },
    };
  }
  return {
    ok: true,
    data: { base64: buffer.toString('base64'), mime: 'image/png', width, height, url: page.url(), title, viewport },
  };
};

const handleResize = async (
  session: Session,
  parameters: Extract<BrowserProviderRequest, { action: 'browser.resize' }>['parameters'],
): Promise<BrowserProviderResult> => {
  const { page, driver } = await session.resolve(parameters.tabId);
  const mode = parameters.viewport;
  const size = mode === 'fill' ? (page.viewportSize() ?? { width: 1280, height: 800 }) : VIEWPORTS[mode];
  await page.setViewportSize({ width: clamp(size.width, 200, 3_840), height: clamp(size.height, 200, 2_160) });
  await page.waitForTimeout(150);
  return { ok: true, data: { viewport: driver.viewportOf(page) } };
};

export const runAction = async (
  profile: string,
  driver: ChromeDriver,
  request: BrowserProviderRequest,
): Promise<BrowserProviderResult> => {
  const session = new Session(profile, driver);
  switch (request.action) {
    case 'browser.open':
      return handleOpen(session, request.parameters);
    case 'browser.snapshot':
      return handleSnapshot(session, request.parameters);
    case 'browser.click':
      return handleClick(session, request.parameters);
    case 'browser.type':
      return handleType(session, request.parameters);
    case 'browser.scroll':
      return handleScroll(session, request.parameters);
    case 'browser.back':
      return handleHistory(session, request.parameters, 'back');
    case 'browser.forward':
      return handleHistory(session, request.parameters, 'forward');
    case 'browser.inspect':
      return handleInspect(session, request.parameters);
    case 'browser.capture':
      return handleCapture(session, request.parameters);
    case 'browser.resize':
      return handleResize(session, request.parameters);
    default:
      return { ok: false, error: `Unsupported action ${String((request as { action: string }).action)}` };
  }
};
