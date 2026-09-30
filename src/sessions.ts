/**
 * One Chrome per agent session, kept in one place.
 *
 * OpenChamber runs a single service for the browser provider and stamps every
 * action with the session it came from, so this is where that stamp turns into
 * a browser: a session id maps to its own driver, its own profile, its own
 * debug port, and therefore its own cookies and logins. Nothing is shared
 * between two sessions.
 *
 * A null session id — an action sent from the CLI, or a host that has no
 * session — keeps the long-standing single profile, so an existing install
 * keeps its logins.
 *
 * Windows are closed when a session has been untouched for a while, and the
 * least recently used ones go first when too many are open, because each
 * visible window is a real Chrome. Closing a window is the only thing that
 * takes a login away; it is never done implicitly to a session that is in use.
 */
import { MAX_INSTANCES, sessionPaths } from './env.ts';
import { ChromeDriver } from './driver.ts';

const DEFAULT_SESSION = 'shared';

const keyOf = (sessionId: string | null): string => sessionId ?? DEFAULT_SESSION;

class SessionRegistry {
  #drivers = new Map<string, ChromeDriver>();
  #sweeper: NodeJS.Timeout | null = null;

  /** The driver for a session, created on first use. */
  for(sessionId: string | null): ChromeDriver {
    const key = keyOf(sessionId);
    let driver = this.#drivers.get(key);
    if (driver) {
      driver.touch();
      return driver;
    }
    driver = new ChromeDriver(key, sessionPaths(sessionId));
    this.#drivers.set(key, driver);
    driver.touch();
    this.#ensureSweeper();
    return driver;
  }

  /** Every session that currently has a window, most recently used first. */
  list(): Array<{ session: string; status: ReturnType<ChromeDriver['status']>; recentLog: string[]; idleMs: number }> {
    return [...this.#drivers.values()]
      .sort((left, right) => left.idleMs - right.idleMs)
      .map((driver) => ({
        session: driver.session,
        status: driver.status(),
        recentLog: driver.recentLog().slice(-6),
        idleMs: driver.idleMs,
      }));
  }

  /** Stops a session's window now; used by shutdown and by the instance cap. */
  async close(session: string, options: { hard?: boolean; forget?: boolean } = {}): Promise<void> {
    const driver = this.#drivers.get(session);
    if (!driver) return;
    if (options.forget !== false) this.#drivers.delete(session);
    await driver.close(options.hard === true);
  }

  async closeAll(options: { hard?: boolean } = {}): Promise<void> {
    const sessions = [...this.#drivers.keys()];
    await Promise.all(sessions.map((session) => this.close(session, options)));
  }

  #ensureSweeper(): void {
    if (this.#sweeper) return;
    this.#sweeper = setInterval(() => {
      void this.#sweep();
    }, 60_000);
    this.#sweeper.unref();
  }

  async #sweep(): Promise<void> {
    // Windows are not closed for being idle: that is the point of them. Only
    // the instance cap closes anything, and it takes the least recently used.
    const overflow = this.list().slice(MAX_INSTANCES);
    for (const entry of overflow) {
      await this.close(entry.session, { hard: true });
    }
  }
}

export const sessions = new SessionRegistry();

export { DEFAULT_SESSION };
