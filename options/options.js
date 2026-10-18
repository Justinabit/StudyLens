/*
  options.js
  ----------
  Loads settings into the form and saves every change straight back to
  chrome.storage.local (no Save button). The side panel listens for these
  changes, so a new key or preference takes effect there immediately.
  Also offers "Test connection" and a way to clear all StudyLens data from
  this device (see README > Privacy).
*/

const KEY_PATTERNS = {
  gemini: /^AIza/,
  openai: /^sk-(?!ant-)/,
  anthropic: /^sk-ant-/
};

const $ = (id) => document.getElementById(id);

const els = {
  providerGroup: $("provider-group"),
  apiKeyInput: $("api-key-input"),
  toggleKeyBtn: $("toggle-key-visibility"),
  keyLink: $("key-link"),
  providerHelp: $("provider-help"),
  keyWarning: $("key-warning"),
  modelInput: $("model-input"),
  testBtn: $("test-btn"),
  testStatus: $("test-status"),
  languageSelect: $("language-select"),
  reviewerModeSelect: $("reviewer-mode-select"),
  quizCountSelect: $("quiz-count-select"),
  quizDifficultySelect: $("quiz-difficulty-select"),
  flashcardCountSelect: $("flashcard-count-select"),
  keyPointCountInput: $("key-point-count-input"),
  keyPointCountValue: $("key-point-count-value"),
  confirmBeforeAICheckbox: $("confirm-before-ai-checkbox"),
  themeGroup: $("theme-group"),
  textSizeGroup: $("text-size-group"),
  shortcutsBtn: $("shortcuts-btn"),
  clearDataBtn: $("clear-data-btn"),
  saveStatus: $("save-status")
};

let settings = normalizeSettings(null);
let saveTimer = 0;
let statusTimer = 0;

buildStaticControls();
attachEventListeners(); // once - re-loading settings never re-attaches listeners
loadSettings();

chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes[STORAGE_KEYS.SETTINGS]) return;
  const incoming = normalizeSettings(changes[STORAGE_KEYS.SETTINGS].newValue);
  // Ignore the echo of our own save; pick up changes made in the side panel.
  if (JSON.stringify(incoming) !== JSON.stringify(settings)) {
    settings = incoming;
    render();
  }
});

window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", applyTheme);

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  settings = normalizeSettings(stored[STORAGE_KEYS.SETTINGS]);
  render();
}

function buildStaticControls() {
  els.providerGroup.innerHTML = Object.entries(AI_PROVIDER_INFO)
    .map(
      ([id, info]) =>
        '<button type="button" class="provider-card" role="radio" data-provider="' + id + '">' +
        '<span class="provider-name">' + info.label + "</span>" +
        '<span class="provider-model">' + info.defaultModel + "</span>" +
        (info.badge ? '<span class="provider-badge">' + info.badge + "</span>" : "") +
        "</button>"
    )
    .join("");

  els.languageSelect.innerHTML = OUTPUT_LANGUAGES.map(
    (lang) => '<option value="' + lang + '">' + (lang === "auto" ? "Same language as the source" : lang) + "</option>"
  ).join("");
}

// Fills every control from `settings`, leaving alone whichever field the
// student is typing in.
function render() {
  const provider = settings.aiProvider;
  const info = AI_PROVIDER_INFO[provider];

  renderProviderCards();

  setValue(els.apiKeyInput, settings.apiKeys[provider] || "");
  els.apiKeyInput.placeholder = info.keyPlaceholder;
  setValue(els.modelInput, settings.models[provider] || "");
  els.modelInput.placeholder = info.defaultModel + " (recommended)";
  els.keyLink.href = info.keyUrl;
  els.providerHelp.textContent = info.keyHelp;
  updateKeyWarning();

  setValue(els.languageSelect, settings.outputLanguage);
  setValue(els.reviewerModeSelect, settings.reviewerMode);
  setValue(els.quizCountSelect, String(settings.quizQuestionCount));
  setValue(els.quizDifficultySelect, settings.quizDifficulty);
  setValue(els.flashcardCountSelect, String(settings.flashcardCount));
  setValue(els.keyPointCountInput, String(settings.keyPointCount));
  els.keyPointCountValue.textContent = settings.keyPointCount;
  els.confirmBeforeAICheckbox.checked = settings.confirmBeforeAI;

  setPills(els.themeGroup, settings.theme);
  setPills(els.textSizeGroup, settings.textSize);
  applyTheme();
}

// Highlights the chosen provider and marks every provider that has a key saved.
function renderProviderCards() {
  els.providerGroup.querySelectorAll(".provider-card").forEach((card) => {
    const id = card.dataset.provider;
    card.setAttribute("aria-checked", String(id === settings.aiProvider));
    let dot = card.querySelector(".provider-key-dot");
    if (settings.apiKeys[id] && !dot) {
      dot = document.createElement("span");
      dot.className = "provider-key-dot";
      dot.title = "Key saved";
      card.appendChild(dot);
    } else if (!settings.apiKeys[id] && dot) {
      dot.remove();
    }
  });
}

function setValue(input, value) {
  if (document.activeElement !== input) input.value = value;
}

function setPills(group, value) {
  group.querySelectorAll(".pill").forEach((pill) => pill.setAttribute("aria-checked", String(pill.dataset.value === value)));
}

function applyTheme() {
  const root = document.documentElement;
  if (settings.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = settings.theme;
}

function updateKeyWarning() {
  const provider = settings.aiProvider;
  const key = (settings.apiKeys[provider] || "").trim();
  let warning = "";
  if (key && !KEY_PATTERNS[provider].test(key)) {
    const match = Object.keys(KEY_PATTERNS).find((id) => KEY_PATTERNS[id].test(key));
    warning = match
      ? "This looks like " + AI_PROVIDER_INFO[match].label + " key. Did you mean to select " + AI_PROVIDER_INFO[match].shortLabel + " above?"
      : "This doesn't look like " + AI_PROVIDER_INFO[provider].shortLabel + " key - double-check you copied all of it.";
  }
  els.keyWarning.textContent = warning;
  els.keyWarning.classList.toggle("hidden", !warning);
}

function attachEventListeners() {
  els.providerGroup.addEventListener("click", (event) => {
    const card = event.target.closest(".provider-card");
    if (!card || card.dataset.provider === settings.aiProvider) return;
    settings.aiProvider = card.dataset.provider;
    clearTestStatus();
    render();
    save(true);
  });

  els.apiKeyInput.addEventListener("input", () => {
    settings.apiKeys[settings.aiProvider] = els.apiKeyInput.value.trim();
    clearTestStatus();
    updateKeyWarning();
    renderProviderCards();
    save();
  });

  els.modelInput.addEventListener("input", () => {
    settings.models[settings.aiProvider] = els.modelInput.value.trim();
    clearTestStatus();
    save();
  });

  els.toggleKeyBtn.addEventListener("click", () => {
    const reveal = els.apiKeyInput.type === "password";
    els.apiKeyInput.type = reveal ? "text" : "password";
    els.toggleKeyBtn.textContent = reveal ? "Hide" : "Show";
  });

  els.testBtn.addEventListener("click", runConnectionTest);

  const bindSelect = (select, apply) =>
    select.addEventListener("change", () => {
      apply(select.value);
      save(true);
    });
  bindSelect(els.languageSelect, (v) => (settings.outputLanguage = v));
  bindSelect(els.reviewerModeSelect, (v) => (settings.reviewerMode = v));
  bindSelect(els.quizCountSelect, (v) => (settings.quizQuestionCount = Number(v)));
  bindSelect(els.quizDifficultySelect, (v) => (settings.quizDifficulty = v));
  bindSelect(els.flashcardCountSelect, (v) => (settings.flashcardCount = Number(v)));

  els.keyPointCountInput.addEventListener("input", () => {
    settings.keyPointCount = Number(els.keyPointCountInput.value);
    els.keyPointCountValue.textContent = settings.keyPointCount;
    save();
  });

  els.confirmBeforeAICheckbox.addEventListener("change", () => {
    settings.confirmBeforeAI = els.confirmBeforeAICheckbox.checked;
    save(true);
  });

  const bindPills = (group, apply) =>
    group.addEventListener("click", (event) => {
      const pill = event.target.closest(".pill");
      if (!pill) return;
      apply(pill.dataset.value);
      setPills(group, pill.dataset.value);
      applyTheme();
      save(true);
    });
  bindPills(els.themeGroup, (v) => (settings.theme = v));
  bindPills(els.textSizeGroup, (v) => (settings.textSize = v));

  els.shortcutsBtn.addEventListener("click", () => chrome.tabs.create({ url: "chrome://extensions/shortcuts" }));
  els.clearDataBtn.addEventListener("click", clearAllData);
}

function save(immediate) {
  clearTimeout(saveTimer);
  const write = async () => {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
    showSaveStatus("Saved ✓");
  };
  if (immediate) write();
  else saveTimer = setTimeout(write, 350);
}

function showSaveStatus(text) {
  els.saveStatus.textContent = text;
  els.saveStatus.classList.add("is-visible");
  clearTimeout(statusTimer);
  statusTimer = setTimeout(() => els.saveStatus.classList.remove("is-visible"), 1800);
}

function clearTestStatus() {
  els.testStatus.className = "test-status";
  els.testStatus.textContent = "";
}

function setTestStatus(kind, text) {
  els.testStatus.className = "test-status is-" + kind;
  els.testStatus.innerHTML = kind === "pending" ? '<span class="spinner" aria-hidden="true"></span>' : "";
  els.testStatus.append(document.createTextNode((kind === "ok" ? "✓ " : kind === "error" ? "✕ " : "") + text));
}

async function runConnectionTest() {
  const provider = settings.aiProvider;
  const apiKey = (settings.apiKeys[provider] || "").trim();
  if (!apiKey) {
    setTestStatus("error", "Enter an API key first.");
    els.apiKeyInput.focus();
    return;
  }

  els.testBtn.disabled = true;
  setTestStatus("pending", "Contacting " + AI_PROVIDER_INFO[provider].shortLabel + "…");
  try {
    await testConnection({
      provider,
      apiKey,
      model: activeModel(settings),
      language: "auto",
      signal: AbortSignal.timeout(45000)
    });
    setTestStatus("ok", "Connected - " + activeModel(settings) + " is ready.");
  } catch (err) {
    const message =
      err && err.code === "cancelled" ? "No response after 45 seconds. Check your connection and try again." : (err && err.message) || "The test failed.";
    setTestStatus("error", message);
  } finally {
    els.testBtn.disabled = false;
  }
}

async function clearAllData() {
  const confirmed = confirm(
    "This removes your saved StudyLens settings, API keys, and current study session from this device. Continue?"
  );
  if (!confirmed) return;

  await chrome.storage.local.clear();
  await chrome.storage.session.clear();
  await loadSettings();
  clearTestStatus();
  showSaveStatus("All StudyLens data cleared");
}
