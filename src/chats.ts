/**
 * Which profile each agent chat uses, remembered across service restarts.
 *
 * The browser tool cannot carry a profile choice: its parameters are set by the
 * host, not the model. So the choice is made in the panel, stored here by chat
 * id, and read on every action. A chat nobody has chosen for uses the default
 * profile. Only the most recent chats are kept, so the file stays small.
 */
import fs from 'node:fs';
import path from 'node:path';

import { BASE_PROFILE_DIR, DEFAULT_PROFILE, isProfileName, type ProfileName } from './env.ts';
import { describeError } from './util.ts';

const FILE = path.join(BASE_PROFILE_DIR, 'chats.json');
const LIMIT = 50;

export type ChatEntry = { sessionId: string; profile: ProfileName; lastUsed: string };

class ChatStore {
  /** Most recently used first. Loaded on first use. */
  #chats: ChatEntry[] | null = null;

  #load(): ChatEntry[] {
    if (this.#chats) return this.#chats;
    this.#chats = [];
    try {
      const parsed = JSON.parse(fs.readFileSync(FILE, 'utf8')) as { chats?: unknown };
      for (const entry of Array.isArray(parsed.chats) ? parsed.chats : []) {
        const candidate = entry as Partial<ChatEntry>;
        if (typeof candidate.sessionId === 'string' && isProfileName(candidate.profile)) {
          this.#chats.push({
            sessionId: candidate.sessionId,
            profile: candidate.profile,
            lastUsed: typeof candidate.lastUsed === 'string' ? candidate.lastUsed : '',
          });
        }
      }
    } catch {
      // No file yet, or one this version cannot read: start empty. The next
      // change rewrites it.
    }
    return this.#chats;
  }

  #save(): void {
    try {
      fs.mkdirSync(path.dirname(FILE), { recursive: true });
      const temp = `${FILE}.tmp`;
      fs.writeFileSync(temp, JSON.stringify({ chats: this.#load() }, null, 2));
      fs.renameSync(temp, FILE);
    } catch (error) {
      console.error(`[openchamber-chrome] could not save ${FILE}: ${describeError(error)}`);
    }
  }

  #touch(sessionId: string, profile: ProfileName): ChatEntry[] {
    const chats = this.#load();
    const index = chats.findIndex((chat) => chat.sessionId === sessionId);
    if (index >= 0) chats.splice(index, 1);
    chats.unshift({ sessionId, profile, lastUsed: new Date().toISOString() });
    if (chats.length > LIMIT) chats.length = LIMIT;
    return chats;
  }

  /** The profile a chat uses. Also records the chat as recently used. */
  profileOf(sessionId: string): ProfileName {
    const known = this.#load().find((chat) => chat.sessionId === sessionId);
    const profile = known?.profile ?? DEFAULT_PROFILE;
    this.#touch(sessionId, profile);
    // Only a chat seen for the first time changes the file; the order in memory
    // is good enough for the rest.
    if (!known) this.#save();
    return profile;
  }

  /** Points a chat at a profile, and keeps it there across restarts. */
  assign(sessionId: string, profile: ProfileName): void {
    this.#touch(sessionId, profile);
    this.#save();
  }

  list(): ChatEntry[] {
    return [...this.#load()];
  }
}

export const chats = new ChatStore();
