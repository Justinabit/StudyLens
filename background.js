/*
  background.js
  -------------
  StudyLens keeps this file small on purpose (see README > Background
  Service Worker). It does not watch tabs or make AI requests (those run in
  the side panel - see the note at the top of aiService.js). It only wakes
  up to:
    1. Save default settings on install, and upgrade settings from 1.x.
    2. Make the toolbar icon open the side panel.
    3. Handle the right-click menu ("Explain with StudyLens" /
       "Study selected text with StudyLens").
*/

importScripts("constants.js");

const MENU_IDS = {
  EXPLAIN: "studylens-explain-selection",
  STUDY: "studylens-study-selection"
};

chrome.runtime.onInstalled.addListener(async () => {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: normalizeSettings(stored[STORAGE_KEYS.SETTINGS]) });

  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({ id: MENU_IDS.EXPLAIN, title: "Explain “%s” with StudyLens", contexts: ["selection"] });
    chrome.contextMenus.create({ id: MENU_IDS.STUDY, title: "Study selected text with StudyLens", contexts: ["selection"] });
  });
});

// StudyLens's interface is a side panel (full-height, stays open while you
// browse) rather than a small popup - see README > Why a Side Panel.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("StudyLens: could not set side panel behavior.", err));

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (!tab || (info.menuItemId !== MENU_IDS.EXPLAIN && info.menuItemId !== MENU_IDS.STUDY)) return;

  // sidePanel.open() only works during the click itself, so it must be
  // called before anything is awaited.
  chrome.sidePanel.open({ windowId: tab.windowId }).catch((err) => console.error("StudyLens: could not open the side panel.", err));

  queuePendingAction(info, tab);
});

// The side panel picks this up from storage.session (memory only) as soon
// as it's open - see sidepanel.js > handlePendingAction.
async function queuePendingAction(info, tab) {
  let text = info.selectionText || "";
  try {
    // The menu's selectionText loses line breaks; read the selection itself
    // when the page allows it (the right-click grants activeTab).
    const [result] = await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [info.frameId || 0] },
      func: () => String(window.getSelection() || "")
    });
    if (result && result.result && result.result.trim().length >= text.trim().length) text = result.result;
  } catch (err) {
    // Some pages (PDF viewer, Chrome pages) can't be scripted - keep selectionText.
  }

  await chrome.storage.session.set({
    [STORAGE_KEYS.PENDING_ACTION]: {
      type: info.menuItemId === MENU_IDS.EXPLAIN ? "explain" : "study",
      text: text.trim(),
      title: tab.title || "",
      url: tab.url || info.pageUrl || "",
      tabId: tab.id,
      windowId: tab.windowId,
      at: Date.now()
    }
  });
}
