/**
 * Copy & Paste Freedom — content script
 *
 * Injected at document_start on every frame, before any page script runs.
 *
 * How sites block copy:
 *   - JS listeners on "copy", "cut", "contextmenu", "selectstart",
 *     "dragstart", ... that call e.preventDefault()
 *   - Inline handlers like document.oncopy = () => false
 *   - CSS: user-select: none
 *   - Swallowing the keyboard: Ctrl+C / Ctrl+X / Ctrl+A get
 *     preventDefault()-ed by the page
 *   - Clearing the selection on every "selectionchange"
 *
 * How sites block paste (the sneaky part):
 *   - Killing the "paste" event (preventDefault) — classic
 *   - Blocking "beforeinput" with inputType "insertFromPaste"
 *   - Letting the paste happen, then REVERTING it: an "input" listener that
 *     restores the old value whenever inputType is "insertFromPaste"
 *   - Custom editors that only insert content from their own paste handler
 *
 * The strategy:
 *   Event listeners registered with capture:true on `window` run before ANY
 *   page handler (window is the first stop of every event's journey, and
 *   capture phase always precedes bubble phase). When the toggle is ON we
 *   stop clipboard-related events right there with stopImmediatePropagation(),
 *   so page handlers never fire and never get the chance to preventDefault().
 *
 *   Paste gets the heavy-duty treatment: we read the clipboard text straight
 *   out of the paste event, cancel the default insertion, and insert the text
 *   ourselves via document.execCommand("insertText") — the exact same path
 *   real typing takes. It fires a normal "input" event with inputType
 *   "insertText", so:
 *     - paste-reverting scripts see nothing to revert
 *     - React/Vue/Angular state updates exactly as if the user typed
 *     - custom editors' mutation observers pick it up like typed text
 *
 * While the toggle is OFF nothing intercepts anything, so pages behave
 * exactly as they would without the extension — and toggling OFF instantly
 * restores a page, no refresh needed.
 */
(() => {
  'use strict';

  // Events whose page-side listeners must never see the light of day
  // while freedom mode is ON. ("paste" gets its own dedicated handler below.)
  const STOP_EVENTS = [
    'copy', 'cut',
    'beforecopy', 'beforecut', 'beforepaste',
    'contextmenu', 'selectstart', 'dragstart',
    'selectionchange'
  ];

  const CSS = `
    *, *::before, *::after {
      -webkit-user-select: text !important;
      user-select: text !important;
    }
    ::selection {
      background-color: rgba(59, 130, 246, 0.35) !important;
    }
  `;

  // Keyboard shortcuts sites love to swallow: Ctrl/Cmd + C, X, V, A.
  const CLIPBOARD_KEYS = new Set(['c', 'x', 'v', 'a']);

  let enabled = false;
  let styleEl = null;

  function ensureStyle() {
    if (styleEl && styleEl.isConnected) return;
    styleEl = document.createElement('style');
    styleEl.id = 'cpf-freedom-style';
    styleEl.textContent = CSS;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  function apply(state) {
    enabled = !!state;
    if (enabled) {
      ensureStyle();
    } else if (styleEl) {
      styleEl.remove();
      styleEl = null;
    }
  }

  // --- Capture-phase guards (registered once, at document_start) ----------

  function stopForPage(e) {
    if (!enabled) return;

    // "beforeinput" needs a surgical touch: only hijack paste/drop-driven
    // insertions, so normal typing and site-side input masking keep working.
    if (e.type === 'beforeinput') {
      const t = e.inputType;
      if (t !== 'insertFromPaste' && t !== 'insertFromDrop') return;
    }

    // Stop the page's handlers — never the browser's default behaviour.
    e.stopImmediatePropagation();
  }

  function stopClipboardKeys(e) {
    if (!enabled) return;
    if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
    const key = (e.key || '').toLowerCase();
    if (CLIPBOARD_KEYS.has(key)) e.stopImmediatePropagation();
  }

  /**
   * Figures out where the caret currently lives.
   */
  function currentEditable() {
    const el = document.activeElement;
    if (el) {
      const tag = el.tagName;
      if (tag === 'TEXTAREA') return { kind: 'textcontrol', el };
      if (tag === 'INPUT' && !/^(file|checkbox|radio|button|submit|reset|image|range|color)$/i.test(el.type || 'text')) {
        return { kind: 'textcontrol', el };
      }
      if (el.isContentEditable) return { kind: 'rich', el };
    }
    // Focus quirks (shadow DOM hosts etc.): the selection may still sit
    // inside a contenteditable even when activeElement says otherwise.
    const sel = document.getSelection();
    if (sel && sel.rangeCount) {
      let n = sel.focusNode;
      while (n) {
        if (n.nodeType === 1 && n.isContentEditable) return { kind: 'rich', el: n };
        n = n.parentNode;
      }
    }
    return { kind: 'none', el: null };
  }

  /**
   * Inserts `text` at the caret as if the user had typed it.
   * execCommand("insertText") goes through the exact same editing pipeline
   * as real keystrokes: it fires beforeinput/input with inputType
   * "insertText", keeps undo working, and updates framework state.
   */
  function insertAsTyping(text) {
    const target = currentEditable();

    // Rich text fields: real typing splits lines with explicit line breaks,
    // so a multi-line paste has to do the same (a raw \n inside one text node
    // would render collapsed).
    if (target.kind === 'rich' && text.includes('\n')) {
      const parts = text.split('\n');
      try {
        for (let i = 0; i < parts.length; i++) {
          if (i > 0 && !document.execCommand('insertLineBreak', false)) {
            document.execCommand('insertHTML', false, '<br>');
          }
          if (parts[i]) document.execCommand('insertText', false, parts[i]);
        }
        return;
      } catch (_) {
        /* fall through to the simple path */
      }
    }

    try {
      if (document.execCommand('insertText', false, text)) return;
    } catch (_) { /* fall through to the manual fallback */ }

    // Manual fallback for plain <input>/<textarea> if execCommand refuses.
    try {
      const el = target.el;
      if (target.kind === 'textcontrol' && typeof el.setRangeText === 'function') {
        const s = typeof el.selectionStart === 'number' ? el.selectionStart : el.value.length;
        const e = typeof el.selectionEnd === 'number' ? el.selectionEnd : el.value.length;
        el.setRangeText(text, s, e, 'end');
        let ev;
        try {
          ev = new InputEvent('input', { bubbles: true, inputType: 'insertText', data: text });
        } catch (_) {
          ev = new Event('input', { bubbles: true });
        }
        el.dispatchEvent(ev);
      }
    } catch (_) { /* nothing more we can do */ }
  }

  /**
   * The paste handler — the heavy-duty path.
   */
  function onPaste(e) {
    if (!enabled) return;

    // 1) The site must never see this event (its handler would block it,
    //    or worse, "handle" it for a custom editor we're bypassing).
    e.stopImmediatePropagation();

    // 2) clipboardData is only readable during the event, so grab it now.
    const text = e.clipboardData ? e.clipboardData.getData('text/plain') : '';

    // 3) Empty text means an empty clipboard or an image/rich-only copy —
    //    leave the default action alive so those can still go through.
    if (!text) return;

    // 4) We own the insertion from here: cancel the default (which some
    //    sites detect and revert via "insertFromPaste" input events) and
    //    type the text in instead.
    e.preventDefault();
    insertAsTyping(text);
  }

  for (const type of STOP_EVENTS) {
    window.addEventListener(type, stopForPage, true);
  }
  window.addEventListener('keydown', stopClipboardKeys, true);
  window.addEventListener('beforeinput', stopForPage, true);
  window.addEventListener('paste', onPaste, true);

  // --- State plumbing -------------------------------------------------------

  chrome.storage.local.get('enabled', ({ enabled }) => {
    apply(enabled !== false); // default ON until the user says otherwise
  });

  // The popup / keyboard shortcut just flip storage; every open page
  // picks the change up live through this listener.
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && 'enabled' in changes) {
      apply(changes.enabled.newValue !== false);
    }
  });

  // Late parser work (document.write, SPA scaffolding) can evict our
  // stylesheet — re-attach it at the moments a page finishes building itself.
  document.addEventListener('readystatechange', () => {
    if (enabled) ensureStyle();
  });
  window.addEventListener('DOMContentLoaded', () => {
    if (enabled) ensureStyle();
  });
})();
