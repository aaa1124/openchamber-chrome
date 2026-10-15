/**
 * The extension's own panel: the three profiles, each with one Chrome window,
 * and the chats that use them. A chat uses the default profile until it is
 * pointed at another one here.
 *
 * The address field opens a page in the default profile's window, the one a
 * person signs into.
 *
 * The panel is a sandboxed iframe. It reaches its service only through the host
 * proxy (`host.serviceRequest`), never a socket of its own.
 */
import { connectHost } from '@openchamber/sdk';

const host = connectHost();

const address = document.getElementById('address');
const go = document.getElementById('go');
const status = document.getElementById('status');
const profileList = document.getElementById('profiles');
const chatList = document.getElementById('chats');
const error = document.getElementById('error');

const showError = (message) => {
  if (!message) {
    error.hidden = true;
    error.textContent = '';
    return;
  }
  error.hidden = false;
  error.textContent = message;
};

const call = async (method, path, body) => {
  const result = await host.serviceRequest(
    body === undefined ? { method, path } : { method, path, body: JSON.stringify(body) },
  );
  if (result.status === 401) throw new Error('The service refused the request (not approved yet?)');
  return result.body ? JSON.parse(result.body) : null;
};

const profileRow = (entry) => {
  const row = document.createElement('li');
  const title = document.createElement('div');
  const dot = document.createElement('span');
  dot.className = `dot ${entry.chrome ?? 'stopped'}`;
  const name = document.createElement('strong');
  name.textContent = entry.name;
  title.append(dot, name);
  const detail = document.createElement('div');
  detail.className = 'muted';
  detail.textContent = entry.chrome === 'stopped' ? 'no window open yet' : `${entry.pages} tab(s) · port ${entry.port}`;
  row.append(title, detail);
  const lastLine = (entry.log ?? []).slice(-1)[0];
  if (lastLine) {
    const line = document.createElement('div');
    line.className = 'muted small';
    line.textContent = lastLine.replace(/^[0-9T:.Z-]+ /, '');
    row.append(line);
  }
  if (entry.lastError) {
    const line = document.createElement('div');
    line.className = 'error';
    line.textContent = entry.lastError;
    row.append(line);
  }
  return row;
};

const chatRow = (chat, names) => {
  const row = document.createElement('li');
  row.className = 'chat';
  const label = document.createElement('span');
  label.className = 'small';
  label.textContent = `Chat ${chat.sessionId.slice(0, 14)}…`;
  label.title = chat.sessionId;
  const choice = document.createElement('select');
  choice.setAttribute('aria-label', 'Profile for this chat');
  for (const name of names) {
    const option = document.createElement('option');
    option.value = name;
    option.textContent = name;
    option.selected = name === chat.profile;
    choice.append(option);
  }
  choice.addEventListener('change', async () => {
    choice.disabled = true;
    try {
      await call('POST', '/chat-profile', { sessionId: chat.sessionId, profile: choice.value });
      showError('');
    } catch (failure) {
      showError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      choice.disabled = false;
      await refresh();
    }
  });
  row.append(label, choice);
  return row;
};

/** Chat rows are rebuilt only when the chats change, so an open menu survives the refresh. */
let renderedChats = null;

const render = (state) => {
  const profiles = state.profiles ?? [];
  const chats = [...(state.chats ?? [])].sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  const windows = profiles.filter((entry) => entry.chrome !== 'stopped').length;
  status.textContent = `${windows}/${profiles.length} profile window(s) open`;
  profileList.replaceChildren(...profiles.map(profileRow));

  const key = chats.map((chat) => `${chat.sessionId}=${chat.profile}`).join('|');
  if (key === renderedChats) return;
  renderedChats = key;
  if (chats.length === 0) {
    const empty = document.createElement('li');
    empty.className = 'muted small';
    empty.textContent = 'No chat has used the browser yet.';
    chatList.replaceChildren(empty);
    return;
  }
  const names = profiles.map((entry) => entry.name);
  chatList.replaceChildren(...chats.map((chat) => chatRow(chat, names)));
};

const refresh = async () => {
  try {
    render(await call('GET', '/state'));
    showError('');
  } catch (failure) {
    showError(failure instanceof Error ? failure.message : String(failure));
  }
};

go.addEventListener('click', async () => {
  const target = address.value.trim();
  if (target.length === 0) return;
  go.disabled = true;
  try {
    await call('POST', '/navigate', { url: target });
    showError('');
  } catch (failure) {
    showError(failure instanceof Error ? failure.message : String(failure));
  } finally {
    go.disabled = false;
    await refresh();
  }
});

address.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') go.click();
});

void refresh();
setInterval(() => {
  void refresh();
}, 4000);
