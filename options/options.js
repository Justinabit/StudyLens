/*
  options.js
  ----------
  Loads current settings into the form, saves changes back to
  chrome.storage.local, and offers a way to clear all StudyLens data from
  this device (see README > Privacy).
*/

const providerSelect = document.getElementById("provider-select");
const apiKeyInput = document.getElementById("api-key-input");
const toggleKeyBtn = document.getElementById("toggle-key-visibility");
const reviewerModeSelect = document.getElementById("reviewer-mode-select");
const keyPointCountInput = document.getElementById("key-point-count-input");
const confirmBeforeAICheckbox = document.getElementById("confirm-before-ai-checkbox");
const clearDataBtn = document.getElementById("clear-data-btn");
const saveBtn = document.getElementById("save-btn");
const saveStatus = document.getElementById("save-status");

const providerHelp = document.getElementById("provider-help");

const PROVIDER_HELP = {
  openai: "Get an OpenAI key at platform.openai.com. Requires billing set up on your OpenAI account.",
  gemini: "Get a free Gemini key at aistudio.google.com/apikey. Gemini's free tier has daily limits.",
  anthropic: "Anthropic support is not implemented in this build yet."
};
const PROVIDER_PLACEHOLDER = {
  openai: "sk-…",
  gemini: "AIza…",
  anthropic: ""
};

function updateProviderHelp() {
  const provider = providerSelect.value;
  providerHelp.textContent = PROVIDER_HELP[provider] || "";
  apiKeyInput.placeholder = PROVIDER_PLACEHOLDER[provider] || "";
}

init();

async function init() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.SETTINGS] || {}) };

  providerSelect.value = settings.aiProvider;
  apiKeyInput.value = settings.apiKey;
  reviewerModeSelect.value = settings.reviewerMode;
  keyPointCountInput.value = settings.keyPointCount;
  confirmBeforeAICheckbox.checked = settings.confirmBeforeAI;
  updateProviderHelp();
  providerSelect.addEventListener("change", updateProviderHelp);

  toggleKeyBtn.addEventListener("click", () => {
    const isHidden = apiKeyInput.type === "password";
    apiKeyInput.type = isHidden ? "text" : "password";
    toggleKeyBtn.textContent = isHidden ? "Hide" : "Show";
  });

  saveBtn.addEventListener("click", saveSettings);
  clearDataBtn.addEventListener("click", clearAllData);
}

async function saveSettings() {
  const count = parseInt(keyPointCountInput.value, 10);

  const settings = {
    aiProvider: providerSelect.value,
    apiKey: apiKeyInput.value.trim(),
    reviewerMode: reviewerModeSelect.value,
    keyPointCount: Number.isFinite(count) ? Math.min(12, Math.max(3, count)) : DEFAULT_SETTINGS.keyPointCount,
    confirmBeforeAI: confirmBeforeAICheckbox.checked
  };

  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
  saveStatus.textContent = "Settings saved!";
  setTimeout(() => (saveStatus.textContent = ""), 2500);
}

async function clearAllData() {
  const confirmed = confirm(
    "This removes your saved StudyLens settings and API key from this device. Continue?"
  );
  if (!confirmed) return;

  await chrome.storage.local.clear();
  saveStatus.textContent = "All StudyLens data cleared.";
  setTimeout(() => {
    saveStatus.textContent = "";
    init();
  }, 1500);
}
