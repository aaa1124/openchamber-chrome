/**
 * Empty stand-in for `playwright`, which playwright-core imports only when it
 * is asked to launch its own bundled browser. This provider always drives an
 * installed Chrome through `executablePath`, so that path is never taken.
 */
export const chromium = undefined;
export const firefox = undefined;
export const webkit = undefined;
export const devices = {};
export const errors = {};
