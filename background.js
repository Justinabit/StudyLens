/*
  background.js
  -------------
  StudyLens keeps this file small on purpose (see README > Background
  Service Worker). It does not run continuously or watch tabs - it only
  wakes up to:
    1. Handle AI generation requests from the popup.
    2. Set sensible default settings the first time StudyLens is installed.
*/

importScripts("constants.js", "aiService.js");

chrome.runtime.onInstalled.addListener((details) => {
  if (details.reason === "install") {
    chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  }
});

// StudyLens's interface is a side panel (full-height, low-scroll) rather
// than a small popup - see README > Why a Side Panel. This makes the
// toolbar icon open it directly.
chrome.sidePanel
  .setPanelBehavior({ openPanelOnActionClick: true })
  .catch((err) => console.error("StudyLens: could not set side panel behavior.", err));

async function getSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.SETTINGS] || {}) };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message || !Object.values(MESSAGE_TYPES).includes(message.type)) {
    return false; // not a message this file handles (e.g. content-script pings)
  }

  handleGenerationRequest(message)
    .then((result) => sendResponse({ ok: true, ...result }))
    .catch((err) => sendResponse({ ok: false, error: err.message || "Something went wrong while contacting the AI service." }));

  return true; // keep the message channel open for the async response above
});

async function handleGenerationRequest(message) {
  const settings = await getSettings();
  const { aiProvider, apiKey, reviewerMode, keyPointCount } = settings;
  const text = message.textContent || "";

  switch (message.type) {
    case MESSAGE_TYPES.GENERATE_SUMMARY:
      return generateSummary(aiProvider, apiKey, text);

    case MESSAGE_TYPES.GENERATE_KEY_POINTS:
      return generateKeyPoints(aiProvider, apiKey, text, keyPointCount);

    case MESSAGE_TYPES.GENERATE_REVIEWER:
      return generateReviewer(aiProvider, apiKey, text, reviewerMode);

    case MESSAGE_TYPES.GENERATE_HIGHLIGHT_PHRASES:
      return generateHighlightPhrases(aiProvider, apiKey, text, message.count);

    default:
      throw new Error("Unsupported generation request.");
  }
}
