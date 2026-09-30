/**
 * Build products the host loads: the service it spawns, and the panel it frames.
 *
 * - `service/main.cjs`: one CommonJS file, Node built-ins external, Playwright
 *   bundled. The host runs it with its own Node runtime and an installed
 *   extension folder has no node_modules, so anything imported at runtime has
 *   to be in this file. CommonJS because playwright-core builds its transports
 *   with `require()` at runtime, which an ESM output cannot host.
 * - `panel/main.built.js`: a classic IIFE. A sandboxed iframe cannot load ESM,
 *   and the panel reaches its service through `@openchamber/sdk`.
 * - `browsers.json`: playwright-core reads its browser registry from this file
 *   at import time, resolved against the package root it was bundled into.
 * - `service/xdg-open`: playwright opens a URL through this helper on Linux;
 *   linked so the path it looks for next to the bundle exists.
 *
 * Three optional peers of playwright-core are aliased to empty modules
 * (see scripts/stubs). They are only reached for use cases this provider does
 * not have — WebDriver BiDi, launching a Playwright browser, driving Electron —
 * and the host runs the service with a bare `node`, so importing them at
 * runtime would fail there anyway. Aliasing keeps the bundle self-contained.
 */
import { copyFile, readFile, symlink, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { build } from 'esbuild';

import { patchBundle } from './patch-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stubs = path.join(root, 'scripts', 'stubs');

const STUBBED_PACKAGES = ['chromium-bidi', 'electron', 'playwright'];

const aliasPlugin = {
  name: 'openchamber-stubs',
  setup(build) {
    build.onResolve({ filter: new RegExp(`^(${STUBBED_PACKAGES.join('|')})(/.*)?$`) }, (args) => ({
      path: path.join(stubs, `${args.path.split('/')[0]}.ts`),
    }));
  },
};

const serviceOutfile = path.join(root, 'service', 'main.cjs');

await build({
  entryPoints: [path.join(root, 'src', 'index.ts')],
  outfile: serviceOutfile,
  bundle: true,
  // CommonJS on purpose: playwright-core builds its transports with
  // `require()` at runtime, and an ESM output cannot host those calls. The
  // .cjs extension is what keeps it CommonJS in this repo, whose
  // package.json says `"type": "module"`, and in an installed extension
  // folder, which has no package.json at all.
  format: 'cjs',
  platform: 'node',
  target: 'node20',
  external: ['node:*'],
  plugins: [aliasPlugin],
  banner: { js: '// Built by scripts/build.mjs from src/. Do not edit; edit the sources.' },
  logLevel: 'warning',
});

// Playwright would kill the Chrome window with the service; a user's session
// in that window must outlive an idle stop. See scripts/patch-bundle.mjs.
await writeFile(serviceOutfile, patchBundle(await readFile(serviceOutfile, 'utf8')));

await build({
  entryPoints: [path.join(root, 'panel', 'main.js')],
  outfile: path.join(root, 'panel', 'main.built.js'),
  bundle: true,
  format: 'iife',
  platform: 'browser',
  target: 'es2020',
  minify: true,
  banner: { js: '// Built by scripts/build.mjs from panel/main.js.' },
  logLevel: 'warning',
});

// playwright-core reads its browser registry from `browsers.json` resolved
// against the package root it is bundled into, so the file ships beside the
// service. Nothing else here reads it.
await copyFile(
  path.join(root, 'node_modules', 'playwright-core', 'browsers.json'),
  path.join(root, 'browsers.json'),
);

// The helper playwright shells out to for `openUrl` on Linux; linking it keeps
// the paths derived from the bundle from pointing at nothing.
const xdgOpen = path.join('node_modules', 'playwright-core', 'lib', 'xdg-open');
await symlink(xdgOpen, path.join(root, 'service', 'xdg-open')).catch(() => undefined);
await symlink(xdgOpen, path.join(root, 'xdg-open')).catch(() => undefined);

console.log('built service/main.cjs, panel/main.built.js, browsers.json and service/xdg-open');