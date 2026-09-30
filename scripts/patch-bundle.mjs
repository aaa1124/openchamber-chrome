/**
 * Patch the bundled playwright launcher so the Chrome window outlives the
 * service.
 *
 * playwright-core's `launchProcess` becomes the leader of a new process group
 * and registers `SIGINT`/`SIGTERM`/`SIGHUP`/`exit` handlers that kill that
 * whole group. In a short-lived script that is right; here it is not. The host
 * stops the service after ten idle minutes and starts it again on the next
 * action, and a user's session (a login, a half-filled form, twenty tabs) lives
 * in that window. Killing it on every stop would throw that away for no reason.
 *
 * With the handlers removed, `driver.ts` answers the next action by attaching
 * to the window that is still listening on the debug port. The patch is
 * verified after applying — if this playwright build ever shapes these lines
 * differently, the build fails loudly instead of silently changing behaviour.
 *
 * See scripts/test-survival.mjs for the check that proves it end to end.
 */

/** The `_launchProcess` defaults: signal handling on. */
export const SIGNAL_DEFAULTS_PATTERN = `const {
              handleSIGINT = true,
              handleSIGTERM = true,
              handleSIGHUP = true
            } = options2;`;

export const SIGNAL_DEFAULTS_REPLACEMENT = `const {
              handleSIGINT = false,
              handleSIGTERM = false,
              handleSIGHUP = false
            } = options2;`;

/**
 * The helper that registers the process handlers itself. Neutralising it is
 * what actually keeps the launcher from closing the browser when this process
 * is signalled.
 */
export const SIGNAL_REGISTRATION_PATTERN = `function addProcessHandlerIfNeeded(name) {
      if (!installedHandlers.has(name)) {
        installedHandlers.add(name);
        process.on(name, processHandlers[name]);
      }
    }`;

export const SIGNAL_REGISTRATION_REPLACEMENT = `function addProcessHandlerIfNeeded(name) {
      // Patched by scripts/patch-bundle.mjs: the Chrome window outlives the
      // service on purpose, so the launcher installs no signal handlers.
      void name;
    }`;

export const patchBundle = (source) => {
  const replacements = [
    ['signal defaults', SIGNAL_DEFAULTS_PATTERN, SIGNAL_DEFAULTS_REPLACEMENT],
    ['signal handler registration', SIGNAL_REGISTRATION_PATTERN, SIGNAL_REGISTRATION_REPLACEMENT],
  ];
  let patched = source;
  for (const [name, pattern, replacement] of replacements) {
    const count = patched.split(pattern).length - 1;
    if (count !== 1) {
      throw new Error(
        `the playwright bundle no longer contains the ${name} block exactly once (found ${count}). ` +
          'Update scripts/patch-bundle.mjs before building.',
      );
    }
    patched = patched.replace(pattern, replacement);
  }
  return patched;
};
