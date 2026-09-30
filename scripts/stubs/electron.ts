/**
 * Empty stand-in for `electron`, which playwright-core imports only when
 * driving an Electron app. This provider drives a browser, never Electron.
 */
export const _electron = undefined;
export const app = undefined;
export const BrowserWindow = undefined;
