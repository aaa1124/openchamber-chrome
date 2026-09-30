# OpenChamber Chrome

An OpenChamber extension that hands the agent's browser tool a real Google
Chrome, in its own window and its own profile.

OpenChamber's browser tool has ten actions (`browser.open`, `browser.snapshot`,
`browser.click`, …). By default a connected desktop app answers them from its
in-app browser panel. This extension answers them instead, from a Chrome it
drives through the Chrome DevTools Protocol, so the agent works in a real
browser: real rendering, real extensions-free profile, real logins if you sign
in once.

The extension folder is this whole repository; the built files it ships are
`service/main.cjs`, `panel/`, `browsers.json` and `icon.svg`.

## Install

1. Build:

   ```bash
   npm install
   npm run build
   ```

2. In OpenChamber, open **Settings → Extensions**, add this folder, and approve
   the local service when asked. The service needs approval once; it runs with
   your full user rights, like every OpenChamber guest service.

3. Open **Settings → General → OpenChamber Tools → Browser provider** and pick
   **Chrome**. The dropdown only lists installed and fully approved extensions,
   so it stays disabled until step 2 is done.

4. Ask an agent to open a page. The first action starts the service and Chrome:

   ```text
   Open https://example.com and tell me what is on it.
   ```

   Chrome opens with a page (not a blank window), the agent reads it, and the
   Chrome window stays there. The provider's own panel in the extension rail
   shows the current state, the tab count, and an address field.

### What the agent drives

| Action | What happens |
|---|---|
| `browser.open` | Opens a new tab in the background and answers its `tabId`, so the page you were looking at is not replaced. Naming a `tabId` navigates that tab instead. |
| `browser.snapshot` | Page text (bounded), interactive elements with usable selectors, tab list, scroll position, and any console warnings or errors since the last snapshot. |
| `browser.click` | By CSS selector or by visible text. Auto-waits for the element to be visible, stable and enabled. |
| `browser.type` | Fills inputs and textareas, chooses `<option>` values in a select, types into contenteditable, and presses Enter when asked. |
| `browser.scroll` | Up, down, top, bottom, or an element into view. |
| `browser.back` / `browser.forward` | Tab history, and says plainly when there is nothing there. |
| `browser.inspect` | Computed styles and geometry of one element. |
| `browser.capture` | A screenshot the host writes into your project and hands the agent as a path. |
| `browser.resize` | Mobile, tablet, desktop, or fill. |

Unknown or closed tab ids are refused with an explanation instead of acting on
some other tab.

## The windows

Each agent session gets **its own Chrome window, on its own profile**. Two
sessions working at once cannot see each other's tabs, cookies or logins, and a
tab id from one session is refused by the other rather than followed.

They also never pull themselves in front of you, and if you would rather not see
them at all, set `OPENCHAMBER_CHROME_HEADLESS=1`: the same rendering and the
same screenshots, with no window to watch or step into. Restart the service
(any action after it idles out) for the change to apply. macOS activates an app the
moment one of its windows opens, which would yank the agent's browser over
whatever you were doing, so the provider starts Chrome with `open -g` instead:
a real, visible window that is simply never activated — not at launch, not when
the agent opens a tab, not even when it switches tabs. Measured on this machine,
`npm run test:focus`:

| Launch | Pulls itself forward on launch | On a new tab | On bring-to-front |
|---|---|---|---|
| plain spawn | yes | yes | yes |
| `open -g` (what ships) | **no** | **no** | **no** |
| off-screen position | yes | yes | yes |

To watch a session work, activate Chrome yourself from the Dock. The extension's
panel in the rail lists every session that has a window, with its tab count and
port.

A tab id carries its session (`a1b2c3:4AC85E5B…`), so the agent always knows
which window it is talking to, and an id from another window is refused.

| Session | Window |
|---|---|
| An agent session | Its own window, profile and cookie jar. |
| No session (CLI, the panel's Open button) | The **default** window — the one you can sign into once and share. |

Windows are kept, not thrown away: the host stops the service after ten idle
minutes and the windows stay where they are, logins and all. Up to
`OPENCHAMBER_CHROME_MAX_INSTANCES` (8) are kept; past that, the least recently
used one is closed.

### The profiles

```
~/OpenChamberChromeProfile/
├── chrome/                    the default window's Chrome profile
├── downloads/                 the default window's downloads
└── sessions/<session>/chrome/ one profile per agent session
```

Set `OPENCHAMBER_CHROME_PROFILE` to put the base directory somewhere else.

### Window lifetime

The window is what a person and an agent share: a login wall you cleared, a form
half filled in, twenty tabs open. It is not a scratch browser that dies with the
automation.

| Event | What happens |
|---|---|
| First action in a session | The host starts the service; the service starts that session's Chrome and attaches to it. |
| Ten idle minutes | The host stops the service. **The windows stay.** |
| Next action | The service attaches to the session's window again — same tabs, same session. |
| Service crashes or is killed | Same: the windows stay, the next action attaches to them. |
| Set `OPENCHAMBER_CHROME_CLOSE_ON_STOP=1` | The service closes the windows it started when it stops, the old behaviour. |

The provider stops Chrome from being killed with the service: playwright's
launcher wants the opposite, and `scripts/patch-bundle.mjs` turns its signal
handlers off at build time. `npm run test:survival` proves a window survives
both SIGTERM and SIGKILL and that the next service adopts it.

If you launch Chrome on one of these profiles yourself, without the debug port,
the provider cannot attach to it and says so: close that window and retry.

### Chrome for Testing

Chrome for stable releases works, and that is what the provider uses by
default. If you would rather leave your normal Chrome out of it entirely,
install [Chrome for Testing] and it is picked up automatically:

```bash
curl -L -o /tmp/cft.zip \
  https://storage.googleapis.com/chrome-for-testing-public/148.0.7778.97/mac-arm64/chrome-mac-arm64.zip
unzip -q /tmp/cft.zip -d /tmp/cft
mv /tmp/cft/chrome-mac-arm64 "/Applications/Google Chrome for Testing.app"
```

[Chrome for Testing]: https://googlechromelabs.github.io/chrome-for-testing/

## Environment

| Variable | Default | Meaning |
|---|---|---|
| `OPENCHAMBER_CHROME_PROFILE` | `~/OpenChamberChromeProfile` | Base directory for the profiles. |
| `OPENCHAMBER_CHROME_DEBUG_PORT` | `9223` | CDP port for the default window; session windows take ports after it. |
| `OPENCHAMBER_CHROME_BIN` | unset | Chrome binary to use, overriding detection. |
| `OPENCHAMBER_CHROME_LAUNCHER` | `open` on macOS, `spawn` elsewhere | How Chrome is started. `open` is what keeps windows from coming to the front. |
| `OPENCHAMBER_CHROME_MAX_INSTANCES` | `8` | Windows kept at once; past this, the least recently used is closed. |
| `OPENCHAMBER_CHROME_HEADLESS` | unset | `1` runs Chrome with no window at all, instead of a window that stays out of the way. |
| `OPENCHAMBER_CHROME_CLOSE_ON_STOP` | unset | `1` closes the windows when the service stops, instead of leaving them. |

`OPENCHAMBER_SERVICE_PORT` and `OPENCHAMBER_SERVICE_TOKEN` are set by
OpenChamber, not by you.

## Development

```bash
npm run typecheck        # TypeScript, DOM and Node in one pass
npm test                 # 29 checks against a real Chrome, no OpenChamber needed
npm run test:sessions    # two sessions, two windows: isolation and tab-id routing
npm run test:focus       # a window never pulls itself in front of the user
npm run test:reconnect   # a Chrome the provider did not start is adopted, not duplicated
npm run test:survival    # windows outlive SIGTERM and SIGKILL, and are adopted again
```

`npm test` starts the built service the way the host does, opens a throwaway
profile under the system temp directory, drives every action over loopback, and
checks the answers — including the failure shapes, which reach the agent as
instructions. It opens a real Chrome window while it runs. Every test picks its
own debug port and profile, so it never disturbs a provider you have running.

Source layout:

| Path | Role |
|---|---|
| `src/index.ts` | The loopback HTTP server, per-session queues, shutdown. |
| `src/sessions.ts` | Which session gets which window, and the instance cap. |
| `src/driver.ts` | One session's Chrome: attach, tabs, downloads, watchers. |
| `src/launcher.ts` | Starting Chrome without taking over the screen, and closing it. |
| `src/actions.ts` | The ten actions, their session routing and answer shapes. |
| `src/snapshot.ts` | The readers injected into the page. |
| `src/env.ts` | Paths, ports, bounds. |
| `panel/` | The extension's panel. |

The service is bundled with esbuild, not run from source: the host executes it
with a bare Node runtime, so everything it imports must be inside the file.
Three optional peers of `playwright-core` (`chromium-bidi`, `playwright`,
`electron`) are stubbed out during the build — they are only reached for use
cases this provider does not have, and importing them at runtime would fail
where they are not installed.

## Troubleshooting

**The Browser provider dropdown is disabled.** The extension is not installed,
not enabled, or its service approval was withdrawn. Settings → Extensions shows
which.

**"A Chrome window is already using the OpenChamber profile…"** You opened that
profile without the debug port. Quit that window, then retry.

**Actions say Chrome is not running and nothing opens.** Check the panel under
the extension rail for the last few log lines, and confirm Chrome exists at
`/Applications/Google Chrome.app` or set `OPENCHAMBER_CHROME_BIN`.

**The agent sees a page you did not expect.** `browser.snapshot` names every
open tab; the agent can address one with `tabId`. Without a `tabId`, actions use
the tab that was activated last.

**Chrome is still open when you are done.** By design: the window is where your
logins live. Close it whenever you like, or set
`OPENCHAMBER_CHROME_CLOSE_ON_STOP=1` to have it closed with the service.

**A window appeared in front of me.** The provider never activates its windows
(`npm run test:focus` proves it). OpenChamber itself comes forward when a tool
result arrives, and that is the app, not the browser. To check, activate
Finder, then run an action: Finder stays in front.
