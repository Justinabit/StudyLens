/*
  constants.js
  ------------
  Shared values used across StudyLens. Keeping them in one place makes the
  extension easier to maintain and extend later (see README > Future
  Improvements).
*/

// Messages sent between the popup, the content script (on the webpage),
// and the background service worker.
const MESSAGE_TYPES = {
  // Popup <-> Content script (direct, tab-specific)
  READ_PAGE: "READ_PAGE",
  HIGHLIGHT_CONTENT: "HIGHLIGHT_CONTENT",
  REMOVE_HIGHLIGHTS: "REMOVE_HIGHLIGHTS",
  SCROLL_TO_HIGHLIGHT: "SCROLL_TO_HIGHLIGHT",

  // Popup <-> Background service worker (AI requests)
  GENERATE_SUMMARY: "GENERATE_SUMMARY",
  GENERATE_KEY_POINTS: "GENERATE_KEY_POINTS",
  GENERATE_REVIEWER: "GENERATE_REVIEWER",
  GENERATE_HIGHLIGHT_PHRASES: "GENERATE_HIGHLIGHT_PHRASES"
};

// Keys used with chrome.storage.local. Only small preferences are stored -
// never full webpages or browsing history (see README > Privacy).
const STORAGE_KEYS = {
  ONBOARDING_SEEN: "studylens_onboarding_seen",
  AI_DISCLOSURE_SEEN: "studylens_ai_disclosure_seen",
  SETTINGS: "studylens_settings"
};

// Default, user-editable settings. Shown and changed on the Settings page.
const DEFAULT_SETTINGS = {
  aiProvider: "openai", // "openai" | "gemini"
  apiKey: "",
  reviewerMode: "comprehensive", // "quick" | "standard" | "comprehensive"
  keyPointCount: 6,
  confirmBeforeAI: true
};

// A webpage or file is considered "insufficient" for study features below
// this word count (see README > Supported Websites / Supported Files).
const MIN_WORD_COUNT = 60;

// Long-content handling (see README > Long Documents). Content longer than
// this is split into chunks before being sent to the AI.
const MAX_CHARS_PER_CHUNK = 9000;

// File upload support (see README > Supported Files).
const FILE_SUPPORT = {
  extensions: ["pdf", "docx", "pptx", "txt", "md", "markdown", "csv", "rtf"],
  acceptAttr: ".pdf,.docx,.pptx,.txt,.md,.markdown,.csv,.rtf",
  maxSizeBytes: 25 * 1024 * 1024, // 25 MB
  maxSizeLabel: "25 MB"
};
