const toggle = document.getElementById('toggle');
const statusEl = document.getElementById('status');
const reloadBtn = document.getElementById('reload');

function render(enabled) {
  toggle.checked = enabled;
  statusEl.textContent = enabled
    ? 'Copy & paste are unlocked everywhere'
    : 'Copy & paste follow each site\u2019s rules';
}

function fallbackState() {
  chrome.storage.local.get('enabled', ({ enabled }) => {
    render(enabled !== false);
  });
}

chrome.runtime
  .sendMessage({ type: 'GET_STATE' })
  .then((res) => {
    if (res && typeof res.enabled === 'boolean') render(res.enabled);
    else fallbackState();
  })
  .catch(fallbackState);

toggle.addEventListener('change', async () => {
  const enabled = toggle.checked;
  render(enabled);
  try {
    await chrome.storage.local.set({ enabled });
  } catch (_) {
    return;
  }
  // Wake the service worker so it repaints the toolbar badge.
  chrome.runtime.sendMessage({ type: 'SET_STATE', enabled }).catch(() => {});
});

reloadBtn.addEventListener('click', () => {
  chrome.tabs.reload();
  window.close();
});
