/** Small shared helpers. Error text here reaches the agent, so it says what to do. */
import fs from 'node:fs';
import path from 'node:path';

export const exists = (candidate: string): boolean => {
  try {
    fs.accessSync(candidate, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
};

export const expandHome = (candidate: string): string =>
  candidate.startsWith('~/') ? path.join(process.env.HOME ?? '', candidate.slice(2)) : candidate;

/** One name for one Chrome window, so reconnects never open a second one. */
export const CLASS_NAME = 'OpenChamberChrome';

export const clamp = (value: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, Math.round(value)));

export const unique = <T>(values: readonly T[]): T[] => [...new Set(values)];

/** `page.locator()` throws for these; a click by text must not. */
export const isUsableSelector = (selector: string): boolean => {
  const trimmed = selector.trim();
  if (trimmed.length === 0 || trimmed.startsWith('>>')) return false;
  return !/[\r\n]/.test(trimmed);
};

export const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Playwright timeouts are in ms and its errors are long; keep the fix in front. */
export const describeError = (error: unknown): string => {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/\s*\(?Call log:[\s\S]*$/, '').trim() || 'Unknown error';
};
