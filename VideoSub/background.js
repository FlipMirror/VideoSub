'use strict';

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (msg?.type === 'SUBTITLE_PIP_GET_TAB_ID' && sender.tab) {
    sendResponse(sender.tab.id);
  }
});

chrome.action.onClicked.addListener(async (tab) => {
  if (!tab?.id) return;

  try {
    // Make sure the content code exists even on pages where an already-open tab
    // was loaded before the extension was installed/reloaded.
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, allFrames: true },
      files: ['content.js']
    });
  } catch (e) {
    console.warn('[Subtitle PiP] content injection:', e?.message || e);
  }

  try {
    const isLordfilm = /lordfilm|lordserial/i.test(tab.url || '');

    if (isLordfilm) {
      // Lordfilm has two explicit player iframes. The top page knows which one
      // is active via the site's own display state, while the player frames are
      // often cross-origin. Ask only the top frame to relay the toggle to the
      // currently visible player iframe. This prevents ad frames from reacting.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, frameIds: [0] },
        func: () => {
          if (typeof window.__subtitlePiPLordfilmToggle === 'function') {
            window.__subtitlePiPLordfilmToggle();
            return { ok: true, lordfilm: true };
          }
          if (typeof window.__subtitlePiPToggle === 'function') {
            window.__subtitlePiPToggle();
            return { ok: true, fallback: true };
          }
          return { ok: false, reason: 'toggle-not-installed' };
        }
      });
    } else {
      // All other sites retain the proven v1.6.50 all-frame behavior.
      await chrome.scripting.executeScript({
        target: { tabId: tab.id, allFrames: true },
        func: () => {
          if (typeof window.__subtitlePiPToggle === 'function') {
            window.__subtitlePiPToggle();
            return { ok: true };
          }
          return { ok: false, reason: 'toggle-not-installed' };
        }
      });
    }
  } catch (e) {
    console.error('[Subtitle PiP] toggle failed:', e);
  }
});
