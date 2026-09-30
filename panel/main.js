/**
 * The extension's own panel: one row per session that has a Chrome window, and
 * an address field that opens a page in the default session's window — the one
 * a person can sign into and the CLI shares.
 *
 * The panel is a sandboxed iframe. It reaches its service only through the host
 * proxy (`host.serviceRequest`), never a socket of its own.
 */
import { connectHost } from '@openchamber/sdk';

const host = connectHost();

const address = document.getElementById('address');
const go = document.getElementById('go');
const status = document.getElementById('status');
const sessionList = document.getElementById('sessions');
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

const sessionRow = (entry) => {
  const row = document.createElement('li');
  const title = document.createElement('div');
  const dot = document.createElement('span');
  dot.className = `dot ${entry.chrome ?? 'stopped'}`;
  const name = document.createElement('strong');
  name.textContent = entry.session === 'shared' ? 'default' : entry.session;
  title.append(dot, name);
  const detail = document.createElement('div');
  detail.className = 'muted';
  detail.textContent =
    entry.chrome === 'stopped' ? 'no window open yet' : `${entry.pages} tab(s) · port ${entry.port}`;
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

const render = (state) => {
  const entries = state.sessions ?? [];
  const windows = entries.filter((entry) => entry.chrome !== 'stopped').length;
  status.textContent = entries.length === 0 ? 'no sessions yet' : `${windows}/${entries.length} window(s) open`;
  sessionList.replaceChildren(...entries.map(sessionRow));
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
