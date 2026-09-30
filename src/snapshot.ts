/**
 * DOM walking, injected into the page with `page.evaluate`.
 *
 * Everything the agent may name later (a snapshot element) is described with
 * stable data only: an `#id`, ASCII class names, or its visible text. No
 * hashed CSS-in-JS class names, no absolute paths, no auto-generated
 * selectors, because those go stale between a snapshot and the next action.
 *
 * Both functions below are serialized by Playwright and run inside the page,
 * so they may only use DOM globals and their own arguments. They are arrow
 * functions passed directly to `evaluate`, never strings built at runtime:
 * a string built from page data would be an injection.
 */
import { SNAPSHOT_ELEMENTS_MAX, SNAPSHOT_TEXT_MAX } from './env.ts';

export type SnapshotElement = {
  selector: string;
  tag: string;
  bounds: { x: number; y: number; width: number; height: number };
  inViewport?: true;
  type?: string;
  role?: string;
  label?: string;
  disabled?: true;
  missingAccessibleName?: true;
};

export type SnapshotDom = {
  url: string;
  title: string;
  text: string;
  textTotalChars: number;
  interactiveTotal: number;
  elements: SnapshotElement[];
};

export const snapshotScopeOptions = (
  selector: string | undefined,
): { limit: number; textMax: number; scopeSelector: string | null } => ({
  limit: SNAPSHOT_ELEMENTS_MAX,
  textMax: SNAPSHOT_TEXT_MAX,
  scopeSelector: selector ?? null,
});

export const readSnapshot = (options: {
  limit: number;
  textMax: number;
  scopeSelector: string | null;
}): SnapshotDom | null => {
  const root = options.scopeSelector ? document.querySelector(options.scopeSelector) : document.body;
  if (!root) return null;

  const TAG_PRIORITY = ['select', 'textarea', 'input', 'button', 'a'];
  const clean = (value: string | null | undefined): string => (value ?? '').replace(/\s+/g, ' ').trim();
  const isInteractive = (node: Element): boolean => {
    const tag = node.tagName.toLowerCase();
    if (tag === 'a' || tag === 'button' || tag === 'select' || tag === 'textarea') {
      if (tag === 'a') return node.hasAttribute('href');
      return true;
    }
    if (tag === 'input') return (node.getAttribute('type') ?? 'text').toLowerCase() !== 'hidden';
    if (node.hasAttribute('contenteditable') && node.getAttribute('contenteditable') !== 'false') return true;
    const role = node.getAttribute('role') ?? '';
    return [
      'button',
      'link',
      'textbox',
      'checkbox',
      'radio',
      'switch',
      'tab',
      'menuitem',
      'option',
      'combobox',
      'searchbox',
    ].includes(role);
  };

  const asciiClass = (name: string): boolean => /^[A-Za-z0-9_-]+$/.test(name);
  const unique = (probe: string): string => {
    try {
      return document.querySelectorAll(probe).length === 1 ? probe : '';
    } catch {
      return '';
    }
  };

  /** A selector the page will accept, or an empty string. Never guess. */
  const describe = (node: Element): string => {
    const quoted = (value: string): string => `'${value.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    if (node.id && !/[\s"'\\/]/.test(node.id)) return `#${node.id}`;
    const classes = Array.from(node.classList).filter(asciiClass).slice(0, 3);
    const tag = node.tagName.toLowerCase();
    if (classes.length > 0) return `${tag}.${classes.join('.')}`;
    const name = node.getAttribute('name');
    if ((tag === 'input' || tag === 'select' || tag === 'textarea') && name) {
      return unique(`${tag}[name=${quoted(name)}]`) || `${tag}[name=${quoted(name)}]`;
    }
    const type = (node.getAttribute('type') ?? '').toLowerCase();
    if (tag === 'input' && type) {
      return unique(`${tag}[type=${quoted(type)}]`) || `${tag}[type=${quoted(type)}]`;
    }
    const placeholder = node.getAttribute('placeholder');
    if (placeholder) {
      const probe = unique(`${tag}[placeholder=${quoted(placeholder)}]`);
      if (probe) return probe;
    }
    if (tag === 'a') {
      const href = node.getAttribute('href');
      if (href && href.length <= 120) {
        const probe = unique(`a[href=${quoted(href)}]`);
        if (probe) return probe;
      }
    }
    const testId = node.getAttribute('data-testid');
    if (testId) {
      const probe = unique(`[data-testid=${quoted(testId)}]`);
      if (probe) return probe;
    }
    return '';
  };

  const label = (node: Element): string => {
    const aria = clean(node.getAttribute('aria-label'));
    if (aria) return aria.slice(0, 80);
    // A field's current value is what an agent most needs to see; the
    // placeholder is only what it would say when empty.
    if (node instanceof HTMLInputElement || node instanceof HTMLTextAreaElement) {
      const value = clean(node.value);
      if (value) return value.slice(0, 80);
    }
    const text = clean(node.textContent);
    if (text) return text.length > 80 ? `${text.slice(0, 77)}...` : text;
    const placeholder = clean(node.getAttribute('placeholder'));
    if (placeholder) return placeholder.slice(0, 80);
    const title = clean(node.getAttribute('title'));
    if (title) return title.slice(0, 80);
    const value = node instanceof HTMLInputElement ? node.value : '';
    if (value) return value.slice(0, 80);
    return '';
  };

  const withinViewport = (rect: DOMRect): boolean => {
    const width = document.documentElement.clientWidth;
    const height = document.documentElement.clientHeight;
    return (
      rect.width > 0 &&
      rect.height > 0 &&
      rect.bottom > 0 &&
      rect.right > 0 &&
      rect.top < height &&
      rect.left < width
    );
  };

  const found: SnapshotElement[] = [];
  const walk = (node: Element): void => {
    if (isInteractive(node)) {
      const tag = node.tagName.toLowerCase();
      const rect = node.getBoundingClientRect();
      const text = label(node);
      const element: SnapshotElement = {
        selector: describe(node),
        tag,
        bounds: {
          x: Math.round(rect.x),
          y: Math.round(rect.y),
          width: Math.round(rect.width),
          height: Math.round(rect.height),
        },
      };
      if (withinViewport(rect)) element.inViewport = true;
      if (tag === 'input') element.type = (node.getAttribute('type') ?? 'text').toLowerCase();
      const role = node.getAttribute('role');
      if (role) element.role = role;
      if (text) element.label = text;
      if ((node as HTMLInputElement).disabled) element.disabled = true;
      if (!text) element.missingAccessibleName = true;
      found.push(element);
    }
    const children = node.children;
    for (let index = 0; index < children.length; index += 1) walk(children[index] as Element);
  };

  walk(root);
  const rawText = clean(root instanceof HTMLElement ? root.innerText : root.textContent);
  const rank = (element: SnapshotElement): number => {
    const index = TAG_PRIORITY.indexOf(element.tag);
    return index === -1 ? TAG_PRIORITY.length : index;
  };
  const ordered = [...found].sort((left, right) => rank(left) - rank(right));

  return {
    url: document.location.href,
    title: document.title,
    text: rawText.length > options.textMax ? rawText.slice(0, options.textMax) : rawText,
    textTotalChars: rawText.length,
    interactiveTotal: ordered.length,
    elements: ordered.slice(0, options.limit),
  };
};

export const readScrollState = (): { scrollY: number; maxScrollY: number } => ({
  scrollY: Math.round(window.scrollY),
  maxScrollY: Math.max(0, Math.round(document.documentElement.scrollHeight - document.documentElement.clientHeight)),
});

/**
 * The tab's own history, read from the page.
 *
 * Playwright's `page.goBack()` goes through `Page.goBack` on a CDP-attached
 * browser, and against a Chrome this provider started that answered `success:
 * false` while the tab clearly had entries to go back to. The page's own
 * history API is the same one the back button uses, so the provider asks the
 * page instead: `canGoBack` from the Navigation API where it exists (Chrome
 * 102+), the entry count everywhere else.
 */
export const readHistoryState = (): { canGoBack: boolean; canGoForward: boolean } => {
  const navigation = (window as unknown as { navigation?: { canGoBack?: boolean; canGoForward?: boolean } }).navigation;
  const canGoBack = typeof navigation?.canGoBack === 'boolean' ? navigation.canGoBack : window.history.length > 1;
  const canGoForward = typeof navigation?.canGoForward === 'boolean' ? navigation.canGoForward : false;
  return { canGoBack, canGoForward };
};
