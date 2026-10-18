/*
  constants.js
  ------------
  Shared values used across StudyLens (side panel, Settings page, and the
  background service worker). Keeping them in one place makes the
  extension easier to maintain and extend.
*/

// Messages sent from the side panel to the content script on a webpage.
// content.js keeps a local copy of these names (see the note there).
const MESSAGE_TYPES = {
  PING: "PING",
  READ_PAGE: "READ_PAGE",
  HIGHLIGHT_CONTENT: "HIGHLIGHT_CONTENT",
  REMOVE_HIGHLIGHTS: "REMOVE_HIGHLIGHTS",
  SCROLL_TO_HIGHLIGHT: "SCROLL_TO_HIGHLIGHT",
  HIGHLIGHT_STATUS: "HIGHLIGHT_STATUS"
};

// Keys used with chrome.storage. Only settings live in storage.local (on
// disk). The current study session lives in storage.session, which Chrome
// keeps in memory only and clears when the browser closes (see README >
// Privacy).
const STORAGE_KEYS = {
  ONBOARDING_SEEN: "studylens_onboarding_seen",
  SETTINGS: "studylens_settings",
  SESSION: "studylens_session",
  PENDING_ACTION: "studylens_pending_action"
};

// Everything the UI needs to know about each AI provider. The request code
// for each one lives in aiService.js > PROVIDERS.
const AI_PROVIDER_INFO = {
  gemini: {
    label: "Google Gemini",
    shortLabel: "Gemini",
    badge: "Free tier",
    defaultModel: "gemini-3.1-flash-lite",
    keyPlaceholder: "AIza…",
    keyUrl: "https://aistudio.google.com/apikey",
    keyHelp: "Get a free key at aistudio.google.com/apikey. The free tier has per-minute and daily limits."
  },
  openai: {
    label: "OpenAI",
    shortLabel: "OpenAI",
    badge: "",
    defaultModel: "gpt-4o-mini",
    keyPlaceholder: "sk-…",
    keyUrl: "https://platform.openai.com/api-keys",
    keyHelp: "Get a key at platform.openai.com/api-keys. Requires billing on your OpenAI account."
  },
  anthropic: {
    label: "Anthropic Claude",
    shortLabel: "Claude",
    badge: "",
    defaultModel: "claude-opus-5-5",
    keyPlaceholder: "sk-ant-…",
    keyUrl: "https://console.anthropic.com/settings/keys",
    keyHelp: "Get a key at console.anthropic.com/settings/keys. Requires credits on your Anthropic account."
  }
};

// Default, user-editable settings. Shown and changed on the Settings page.
const DEFAULT_SETTINGS = {
  aiProvider: "gemini", // key of AI_PROVIDER_INFO
  apiKeys: { gemini: "", openai: "", anthropic: "" },
  models: { gemini: "", openai: "", anthropic: "" }, // "" = provider default
  outputLanguage: "auto", // "auto" = same language as the source
  reviewerMode: "comprehensive", // "quick" | "standard" | "comprehensive"
  keyPointCount: 8,
  quizQuestionCount: 10,
  quizDifficulty: "mixed", // "easy" | "mixed" | "hard"
  flashcardCount: 15,
  confirmBeforeAI: true,
  theme: "system", // "system" | "light" | "dark"
  textSize: "md" // "sm" | "md" | "lg"
};

const OUTPUT_LANGUAGES = [
  "auto", "English", "Filipino", "Spanish", "French", "German", "Portuguese", "Italian",
  "Indonesian", "Vietnamese", "Japanese", "Korean", "Chinese (Simplified)", "Hindi", "Arabic"
];

// Merges stored settings over the defaults and upgrades settings saved by
// StudyLens 1.x, which kept a single "apiKey" for whichever provider was
// selected at the time.
function normalizeSettings(raw) {
  const stored = raw && typeof raw === "object" ? raw : {};
  const settings = { ...DEFAULT_SETTINGS, ...stored };
  settings.apiKeys = { ...DEFAULT_SETTINGS.apiKeys, ...(stored.apiKeys || {}) };
  settings.models = { ...DEFAULT_SETTINGS.models, ...(stored.models || {}) };

  if (!AI_PROVIDER_INFO[settings.aiProvider]) settings.aiProvider = DEFAULT_SETTINGS.aiProvider;
  if (typeof stored.apiKey === "string" && stored.apiKey && !settings.apiKeys[settings.aiProvider]) {
    settings.apiKeys[settings.aiProvider] = stored.apiKey;
  }
  delete settings.apiKey;

  return settings;
}

function activeApiKey(settings) {
  return (settings.apiKeys[settings.aiProvider] || "").trim();
}

function activeModel(settings) {
  return (settings.models[settings.aiProvider] || "").trim() || AI_PROVIDER_INFO[settings.aiProvider].defaultModel;
}

// A webpage or file is considered "insufficient" for study features below
// this word count (see README > Supported Websites / Supported Files).
const MIN_WORD_COUNT = 60;

// Long-content handling (see README > Long Documents). Content longer than
// this is read in parts, then combined. ~48k characters is ~12k tokens -
// comfortably inside every supported model's context window, and large
// enough that most documents need only one request.
const MAX_CHARS_PER_CHUNK = 48000;

// File upload support (see README > Supported Files).
const FILE_SUPPORT = {
  extensions: ["pdf", "docx", "pptx", "txt", "md", "markdown", "csv", "rtf", "html", "htm"],
  acceptAttr: ".pdf,.docx,.pptx,.txt,.md,.markdown,.csv,.rtf,.html,.htm",
  maxSizeBytes: 25 * 1024 * 1024, // 25 MB
  maxSizeLabel: "25 MB"
};
