/**
 * Copy & Paste Freedom — background service worker
 *
 * Owns the canonical ON/OFF state (chrome.storage.local), paints the
 * toolbar badge, and handles the Ctrl+Shift+U keyboard shortcut.
 * Content scripts watch storage directly, so flipping the state here
 * updates every open page live.
 */

const DEFAULT_ENABLED = true;

async function getState() {
  const { enabled } = await chrome.storage.local.get('enabled');
  return enabled === undefined ? DEFAULT_ENABLED : enabled !== false;
}

async function setState(enabled) {
  await chrome.storage.local.set({ enabled: !!enabled });
  await paintBadge(!!enabled);
}

async function paintBadge(enabled) {
  const text = enabled ? 'ON' : 'OFF';
  chrome.action.setBadgeText({ text });
  chrome.action.setBadgeBackgroundColor({ color: enabled ? '#16a34a' : '#6b7280' });
  try {
    chrome.action.setBadgeTextColor({ color: '#ffffff' });
  } catch (_) {
    // Older Chromium without setBadgeTextColor — the badge still works.
  }
  chrome.action.setTitle({ title: `Copy & Paste Freedom — ${text}` });
}

chrome.runtime.onInstalled.addListener(async () => {
  const { enabled } = await chrome.storage.local.get('enabled');
  if (enabled === undefined) {
    await chrome.storage.local.set({ enabled: DEFAULT_ENABLED });
  }
  paintBadge(await getState());
});

chrome.runtime.onStartup.addListener(async () => {
  paintBadge(await getState());
});

chrome.commands.onCommand.addListener(async (command) => {
  if (command === 'toggle-copy-paste') {
    await setState(!(await getState()));
  }
});

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || typeof msg.type !== 'string') return;

  if (msg.type === 'GET_STATE') {
    getState().then((enabled) => sendResponse({ enabled }));
    return true; // async response
  }

  if (msg.type === 'SET_STATE') {
    setState(msg.enabled).then(() => sendResponse({ ok: true }));
    return true; // async response
  }
});
