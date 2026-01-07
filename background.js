/**
 * RL4 Snapshot Extension - Background Service Worker
 * Handles extension lifecycle and optional message routing
 */

const STORAGE_KEYS = {
  LAST_SUPPORTED_TAB: 'rl4_last_supported_tab_v1',
  UI_WINDOW_ID: 'rl4_ui_window_id_v1'
};

function isSupportedUrl(url) {
  const u = String(url || '');
  return (
    u.startsWith('https://claude.ai/') ||
    u.startsWith('https://chatgpt.com/') ||
    u.startsWith('https://chat.openai.com/') ||
    u.startsWith('https://gemini.google.com/') ||
    u.startsWith('https://bard.google.com/') ||
    u.startsWith('https://g.co/')
  );
}

async function rememberSupportedTab(sender, explicitUrl) {
  try {
    const tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
    const windowId = sender && sender.tab && typeof sender.tab.windowId === 'number' ? sender.tab.windowId : null;
    const url = String(explicitUrl || (sender && sender.tab ? sender.tab.url : '') || '');
    if (tabId === null || !isSupportedUrl(url)) return;
    await chrome.storage.local.set({
      [STORAGE_KEYS.LAST_SUPPORTED_TAB]: { tabId, windowId, url, updatedAt: Date.now() }
    });
  } catch (_) {
    // ignore
  }
}

async function setupDeclarativeVisibility() {
  if (!chrome.declarativeContent || !chrome.declarativeContent.onPageChanged) return;
  try {
    await chrome.declarativeContent.onPageChanged.removeRules();
    await chrome.declarativeContent.onPageChanged.addRules([
      {
        conditions: [
          new chrome.declarativeContent.PageStateMatcher({
            pageUrl: { hostEquals: 'claude.ai', schemes: ['https'] }
          }),
          new chrome.declarativeContent.PageStateMatcher({
            pageUrl: { hostEquals: 'chatgpt.com', schemes: ['https'] }
          }),
          new chrome.declarativeContent.PageStateMatcher({
            pageUrl: { hostEquals: 'chat.openai.com', schemes: ['https'] }
          }),
          new chrome.declarativeContent.PageStateMatcher({
            pageUrl: { hostEquals: 'gemini.google.com', schemes: ['https'] }
          }),
          new chrome.declarativeContent.PageStateMatcher({
            pageUrl: { hostEquals: 'bard.google.com', schemes: ['https'] }
          }),
          new chrome.declarativeContent.PageStateMatcher({
            pageUrl: { hostEquals: 'g.co', schemes: ['https'] }
          })
        ],
        actions: [new chrome.declarativeContent.ShowAction()]
      }
    ]);
  } catch (_) {
    // ignore
  }
}

async function updateActionForTab(tabId, url) {
  if (typeof tabId !== 'number') return;
  const supported = isSupportedUrl(url);
  try {
    if (supported) chrome.action.enable(tabId);
    else chrome.action.disable(tabId);
  } catch (_) {
    // ignore
  }
}

// Listen for extension installation
chrome.runtime.onInstalled.addListener((details) => {
  console.log('[RL4] Extension installed', details.reason);
  
  if (details.reason === 'install') {
    console.log('[RL4] First installation - ready to capture Claude conversations');
  } else if (details.reason === 'update') {
    console.log('[RL4] Extension updated');
  }

  // Show the RL4 icon only on supported providers.
  setupDeclarativeVisibility().catch(() => {});
});

// Open RL4 in a pinned side panel (preferred) or a detached window (fallback).
chrome.action.onClicked.addListener(async (tab) => {
  const tabId = tab && typeof tab.id === 'number' ? tab.id : null;
  const tabUrl = tab && tab.url ? String(tab.url) : '';

  // Remember the target tab so the RL4 UI can operate on it even in a detached window.
  await rememberSupportedTab({ tab }, tabUrl);

  // If user clicks the pinned icon on a non-supported site, show a small disclaimer.
  if (!isSupportedUrl(tabUrl)) {
    if (chrome.windows && typeof chrome.windows.create === 'function') {
      chrome.windows.create({
        url: chrome.runtime.getURL('disclaimer.html'),
        type: 'popup',
        width: 360,
        height: 160,
        focused: true
      });
    }
    return;
  }

  // Prefer Side Panel when supported.
  if (chrome.sidePanel && typeof chrome.sidePanel.open === 'function' && tabId !== null) {
    try {
      if (typeof chrome.sidePanel.setOptions === 'function') {
        await chrome.sidePanel.setOptions({ tabId, path: 'popup.html', enabled: true });
      }
    } catch (_) {
      // ignore
    }
    try {
      await chrome.sidePanel.open({ tabId });
      return;
    } catch (_) {
      // fallback below
    }
  }

  // If side panel isn't available, prefer an in-page widget (Crisp/Intercom-style) injected by content.js.
  // (We keep the detached window as a last resort only, for pages where injection fails.)
  try {
    if (tabId !== null) {
      chrome.tabs.sendMessage(tabId, { action: 'openRl4InpagePanel' }, () => {});
      return;
    }
  } catch (_) {}

  // Last resort: detached window that stays open, positioned on the right of the browser window.
  if (chrome.windows && typeof chrome.windows.create === 'function') {
    const width = 460;
    let height = 760;
    let top = 0;
    let left = 0;
    try {
      if (tab && typeof tab.windowId === 'number') {
        const w = await chrome.windows.get(tab.windowId);
        if (w && typeof w.height === 'number') height = Math.max(500, w.height);
        if (w && typeof w.top === 'number') top = w.top;
        if (w && typeof w.left === 'number' && typeof w.width === 'number') {
          left = Math.max(0, w.left + w.width - width);
        }
      }
    } catch (_) {}

    chrome.windows.create({
      url: chrome.runtime.getURL('popup.html'),
      type: 'popup',
      width,
      height,
      left,
      top,
      focused: true
    });
  }
});

// Optional: Handle messages from content script or popup
chrome.runtime.onMessage.addListener((request, sender, sendResponse) => {
  if (request && request.action === 'rl4_supported_tab_ping') {
    const tabId = sender && sender.tab && typeof sender.tab.id === 'number' ? sender.tab.id : null;
    const url = request && request.url ? String(request.url) : (sender && sender.tab ? String(sender.tab.url || '') : '');
    updateActionForTab(tabId, url).catch(() => {});
    rememberSupportedTab(sender, url).then(() => {
      sendResponse({ ok: true });
    });
    return true;
  }

  if (request.action === 'log') {
    console.log('[RL4 Background]', request.message);
    sendResponse({ success: true });
  }
  
  // Return true to indicate we will send a response asynchronously
  return true;
});

// Keep action enabled only on supported sites.
try {
  chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
    const url = changeInfo && typeof changeInfo.url === 'string' ? changeInfo.url : (tab && tab.url ? String(tab.url) : '');
    if (!url) return;
    updateActionForTab(tabId, url).catch(() => {});
  });
  chrome.tabs.onActivated.addListener(async (info) => {
    try {
      const tab = await chrome.tabs.get(info.tabId);
      updateActionForTab(info.tabId, tab && tab.url ? String(tab.url) : '').catch(() => {});
    } catch (_) {}
  });
} catch (_) {
  // ignore
}

