/**
 * The three profiles, one Chrome window each.
 *
 * OpenChamber runs a single service for the browser provider and stamps every
 * action with the chat it came from. A chat uses one profile: the default one,
 * unless someone picked another for that chat in the panel (see chats.ts). Every
 * chat on a profile shares that profile's window, cookies and tabs. Two profiles
 * never share anything.
 *
 * Windows are kept after use, and closed only on shutdown when asked to
 * (OPENCHAMBER_CHROME_CLOSE_ON_STOP=1). A profile's window is one Chrome, so it
 * is never started twice.
 */
import { PROFILE_NAMES, DEFAULT_PROFILE, profilePaths, type ProfileName } from './env.ts';
import { ChromeDriver } from './driver.ts';
import { chats } from './chats.ts';

class ProfileRegistry {
  readonly #drivers: Map<ProfileName, ChromeDriver>;

  constructor() {
    // Creating a driver starts nothing; Chrome starts on the first action.
    this.#drivers = new Map(PROFILE_NAMES.map((name) => [name, new ChromeDriver(name, profilePaths(name))] as const));
  }

  #get(name: ProfileName): ChromeDriver {
    const driver = this.#drivers.get(name);
    if (!driver) throw new Error(`Unknown profile ${name}`);
    return driver;
  }

  /** The driver for a profile, marked as used. */
  driver(name: ProfileName): ChromeDriver {
    const driver = this.#get(name);
    driver.touch();
    return driver;
  }

  /** The driver for the profile a chat uses. A null chat (CLI, the panel's Open button) uses the default. */
  for(sessionId: string | null): ChromeDriver {
    return this.driver(sessionId === null ? DEFAULT_PROFILE : chats.profileOf(sessionId));
  }

  /** Every profile, in the order they are named, whether or not its window is open. */
  list(): Array<{ name: ProfileName; status: ReturnType<ChromeDriver['status']>; recentLog: string[]; idleMs: number }> {
    return PROFILE_NAMES.map((name) => {
      const driver = this.#get(name);
      return { name, status: driver.status(), recentLog: driver.recentLog().slice(-6), idleMs: driver.idleMs };
    });
  }

  /** Stops every window this service has open; used by shutdown. */
  async closeAll(options: { hard?: boolean } = {}): Promise<void> {
    const open = [...this.#drivers.values()].filter((driver) => driver.status().chrome !== 'stopped');
    await Promise.all(open.map((driver) => driver.close(options.hard === true)));
  }
}

export const profiles = new ProfileRegistry();
