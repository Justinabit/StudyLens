/*
  sidepanel.js
  ------------
  Drives the StudyLens side panel. Builds on the same message-passing
  pattern as the original popup (see README > Architecture):
    - content script on the active tab, for webpage reading/highlighting
    - background service worker, for AI generation requests
    - fileParser.js, for turning an uploaded file into text (runs locally
      in this document - no messaging needed)

  Both a scanned webpage and an uploaded file end up as the same shape,
  "activeContent", so every study feature below (summary, key points,
  reviewer, prompts) works identically regardless of where the text came
  from. Only highlighting is webpage-only, since it needs a live page DOM.
*/

const UNSUPPORTED_URL_PATTERNS = [
  /^chrome:\/\//,
  /^chrome-extension:\/\//,
  /^edge:\/\//,
  /^about:/,
  /^https:\/\/chrome\.google\.com\/webstore/,
  /^https:\/\/chromewebstore\.google\.com/
];

const TAB_LABELS = {
  summary: "Summary",
  keyPoints: "Key Points",
  reviewer: "Full Reviewer",
  quizPrompt: "Quiz Prompt",
  flashcardPrompt: "Flashcard Prompt"
};
const TAB_ORDER = ["summary", "keyPoints", "reviewer", "quizPrompt", "flashcardPrompt"];

const LOADING_MESSAGES = {
  summary: ["Finding the main ideas…", "Writing your summary…"],
  keyPoints: ["Spotting what matters…", "Listing key points…"],
  reviewer: ["Organizing the topics…", "Building your full reviewer…", "Almost done…"],
  highlight: ["Finding important passages…", "Highlighting on the page…"]
};

const FILE_KIND_ICON = { pdf: "📄", docx: "📄", pptx: "📊", txt: "📄", md: "📄", csv: "📊", rtf: "📄" };
const FILE_KIND_LABEL = { pdf: "PDF", docx: "Word", pptx: "PowerPoint", txt: "TXT", md: "Markdown", csv: "CSV", rtf: "RTF" };

// ---- State ---------------------------------------------------------------

let currentTab = null;
let lastTabId = null;
let currentSourceTab = "page"; // "page" | "file" - which panel is visible
let activeContent = null; // { sourceType, title, meta, wordCount, textContent, preview }
let currentFileMeta = null; // { name, size, kind } - for the file-info display

let settings = { ...DEFAULT_SETTINGS };
let selectedReviewerMode = DEFAULT_SETTINGS.reviewerMode;

let results = {};
let activeResultKey = null;
let highlightState = { total: 0, current: -1 };
let aiDisclosureAcknowledgedThisSession = false;
let disclosureResolver = null;
let toastTimeoutId = null;

// ---- DOM references --------------------------------------------------------

const el = (id) => document.getElementById(id);

const els = {
  onboardingOverlay: el("onboarding-overlay"),
  onboardingDismiss: el("onboarding-dismiss"),

  disclosureOverlay: el("disclosure-overlay"),
  disclosureContinue: el("disclosure-continue"),
  disclosureCancel: el("disclosure-cancel"),
  disclosureDontAsk: el("disclosure-dont-ask"),

  settingsBtn: el("settings-btn"),

  sourceTabPage: el("source-tab-page"),
  sourceTabFile: el("source-tab-file"),
  sourcePanelPage: el("source-panel-page"),
  sourcePanelFile: el("source-panel-file"),
  sourceCurrentLabel: el("source-current-label"),

  pageTitle: el("page-title"),
  pageDomain: el("page-domain"),
  pageStatus: el("page-status"),
  readPageBtn: el("read-page-btn"),

  fileDropZone: el("file-drop-zone"),
  chooseFileBtn: el("choose-file-btn"),
  fileInput: el("file-input"),
  fileInfo: el("file-info"),
  fileName: el("file-name"),
  fileMeta: el("file-meta"),
  removeFileBtn: el("remove-file-btn"),

  loadingCard: el("loading-card"),
  loadingMessage: el("loading-message"),

  previewSection: el("preview-section"),
  previewWordCount: el("preview-word-count"),
  previewText: el("preview-text"),
  previewContinueBtn: el("preview-continue-btn"),

  studyToolsSection: el("study-tools-section"),
  summarizeBtn: el("summarize-btn"),
  keyPointsBtn: el("key-points-btn"),
  highlightBtn: el("highlight-btn"),

  highlightControls: el("highlight-controls"),
  highlightPrevBtn: el("highlight-prev-btn"),
  highlightNextBtn: el("highlight-next-btn"),
  highlightPosition: el("highlight-position"),
  removeHighlightsBtn: el("remove-highlights-btn"),

  reviewerModeGroup: el("reviewer-mode-group"),
  reviewerBtn: el("reviewer-btn"),
  quizPromptBtn: el("quiz-prompt-btn"),
  flashcardPromptBtn: el("flashcard-prompt-btn"),
  promptHint: el("prompt-hint"),

  resultSection: el("result-section"),
  resultTabs: el("result-tabs"),
  resultChunkNote: el("result-chunk-note"),
  resultText: el("result-text"),
  regenerateBtn: el("regenerate-btn"),
  clearBtn: el("clear-btn"),

  stickyFooter: el("sticky-footer"),
  copyBtn: el("copy-btn"),

  toast: el("toast")
};

// ---- Init ------------------------------------------------------------------

init();

async function init() {
  els.fileInput.accept = FILE_SUPPORT.acceptAttr;

  await loadSettings();
  await maybeShowOnboarding();
  await loadCurrentTab();
  attachEventListeners();
  attachTabChangeTracking();
}

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  settings = { ...DEFAULT_SETTINGS, ...(stored[STORAGE_KEYS.SETTINGS] || {}) };
  selectedReviewerMode = settings.reviewerMode;
  applyReviewerModeUI();
}

function persistSettings() {
  chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
}

async function maybeShowOnboarding() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.ONBOARDING_SEEN);
  if (!stored[STORAGE_KEYS.ONBOARDING_SEEN]) {
    showOverlay(els.onboardingOverlay);
  }
}

async function loadCurrentTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  currentTab = tab || null;
  if (currentTab) lastTabId = currentTab.id;

  if (!currentTab || !currentTab.url) {
    // Most often this means the panel is now looking at a different tab
    // than the one that opened it, and StudyLens's activeTab permission
    // (deliberately minimal - see README > Permissions) hasn't been
    // re-granted for this tab yet.
    els.pageTitle.textContent = "Reconnect to this tab";
    els.pageDomain.textContent = "Click the StudyLens icon in your toolbar, then try again.";
    setPageStatus("StudyLens needs permission to read this tab.", "error");
    els.readPageBtn.disabled = true;
    return;
  }

  const isUnsupported = UNSUPPORTED_URL_PATTERNS.some((pattern) => pattern.test(currentTab.url));
  if (isUnsupported) {
    els.pageTitle.textContent = currentTab.title || "Unsupported page";
    els.pageDomain.textContent = "Try opening a normal webpage containing your study material.";
    setPageStatus("This page cannot be read by StudyLens.", "error");
    els.readPageBtn.disabled = true;
    return;
  }

  els.pageTitle.textContent = currentTab.title || "Untitled page";
  try {
    els.pageDomain.textContent = new URL(currentTab.url).hostname.replace(/^www\./, "");
  } catch (err) {
    els.pageDomain.textContent = "";
  }
  els.readPageBtn.disabled = false;
  setPageStatus("Ready to analyze", "muted");
}

// The side panel stays open across tab switches (unlike the old popup),
// so if the user navigates away while "Webpage" content is active,
// StudyLens treats it as a new study session rather than mixing old
// results with a different page (see README > Source Switching).
function attachTabChangeTracking() {
  chrome.tabs.onActivated.addListener(({ tabId }) => {
    if (lastTabId !== null && tabId !== lastTabId) {
      if (activeContent && activeContent.sourceType === "page") {
        resetContentSession();
      }
      loadCurrentTab();
    }
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (changeInfo.status === "complete" && tabId === lastTabId) {
      if (activeContent && activeContent.sourceType === "page") {
        resetContentSession();
      }
      loadCurrentTab();
    }
  });
}

// ---- Event wiring -----------------------------------------------------------

function attachEventListeners() {
  els.onboardingDismiss.addEventListener("click", () => {
    hideOverlay(els.onboardingOverlay);
    chrome.storage.local.set({ [STORAGE_KEYS.ONBOARDING_SEEN]: true });
  });

  els.disclosureContinue.addEventListener("click", () => {
    aiDisclosureAcknowledgedThisSession = true;
    if (els.disclosureDontAsk.checked) {
      settings.confirmBeforeAI = false;
      persistSettings();
    }
    hideOverlay(els.disclosureOverlay);
    if (disclosureResolver) disclosureResolver(true);
  });
  els.disclosureCancel.addEventListener("click", () => {
    hideOverlay(els.disclosureOverlay);
    if (disclosureResolver) disclosureResolver(false);
  });

  els.settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());

  els.sourceTabPage.addEventListener("click", () => setSourceTab("page"));
  els.sourceTabFile.addEventListener("click", () => setSourceTab("file"));

  els.readPageBtn.addEventListener("click", handleReadPage);

  els.chooseFileBtn.addEventListener("click", () => els.fileInput.click());
  els.fileInput.addEventListener("change", () => {
    const file = els.fileInput.files && els.fileInput.files[0];
    if (file) handleFileSelected(file);
    els.fileInput.value = ""; // allow re-selecting the same file later
  });
  els.removeFileBtn.addEventListener("click", handleRemoveFile);

  ["dragover", "dragenter"].forEach((evt) =>
    els.fileDropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.fileDropZone.classList.add("file-drop-active");
    })
  );
  ["dragleave", "drop"].forEach((evt) =>
    els.fileDropZone.addEventListener(evt, (e) => {
      e.preventDefault();
      els.fileDropZone.classList.remove("file-drop-active");
    })
  );
  els.fileDropZone.addEventListener("drop", (e) => {
    const file = e.dataTransfer.files && e.dataTransfer.files[0];
    if (file) handleFileSelected(file);
  });

  els.previewContinueBtn.addEventListener("click", () => {
    hide(els.previewSection);
    show(els.studyToolsSection);
    const isPage = activeContent && activeContent.sourceType === "page";
    els.highlightBtn.classList.toggle("hidden", !isPage);
    if (!isPage) hide(els.highlightControls);
  });

  els.summarizeBtn.addEventListener("click", () => generateAndShow("summary", MESSAGE_TYPES.GENERATE_SUMMARY));
  els.keyPointsBtn.addEventListener("click", () => generateAndShow("keyPoints", MESSAGE_TYPES.GENERATE_KEY_POINTS));
  els.reviewerBtn.addEventListener("click", () =>
    generateAndShow("reviewer", MESSAGE_TYPES.GENERATE_REVIEWER, { reviewerMode: selectedReviewerMode })
  );

  els.reviewerModeGroup.addEventListener("click", (event) => {
    const btn = event.target.closest(".segment");
    if (!btn) return;
    selectedReviewerMode = btn.dataset.mode;
    settings.reviewerMode = selectedReviewerMode;
    persistSettings();
    applyReviewerModeUI();
  });

  els.highlightBtn.addEventListener("click", handleHighlight);
  els.removeHighlightsBtn.addEventListener("click", handleRemoveHighlights);
  els.highlightPrevBtn.addEventListener("click", () => moveHighlight(-1));
  els.highlightNextBtn.addEventListener("click", () => moveHighlight(1));

  els.quizPromptBtn.addEventListener("click", () => buildPromptResult("quizPrompt"));
  els.flashcardPromptBtn.addEventListener("click", () => buildPromptResult("flashcardPrompt"));

  els.resultTabs.addEventListener("click", (event) => {
    const key = event.target.dataset && event.target.dataset.key;
    if (key) {
      activeResultKey = key;
      renderResults();
    }
  });

  els.copyBtn.addEventListener("click", handleCopy);
  els.regenerateBtn.addEventListener("click", handleRegenerate);
  els.clearBtn.addEventListener("click", handleClear);
}

function applyReviewerModeUI() {
  Array.from(els.reviewerModeGroup.querySelectorAll(".segment")).forEach((btn) => {
    btn.setAttribute("aria-checked", String(btn.dataset.mode === selectedReviewerMode));
  });
}

// ---- Source switching --------------------------------------------------------

function setSourceTab(tab) {
  currentSourceTab = tab;
  els.sourceTabPage.setAttribute("aria-selected", String(tab === "page"));
  els.sourceTabFile.setAttribute("aria-selected", String(tab === "file"));
  els.sourcePanelPage.classList.toggle("hidden", tab !== "page");
  els.sourcePanelFile.classList.toggle("hidden", tab !== "file");
}

function updateSourceLabel() {
  if (!activeContent) {
    els.sourceCurrentLabel.textContent = "";
    return;
  }
  const label = activeContent.sourceType === "page" ? "Webpage" : activeContent.title;
  els.sourceCurrentLabel.textContent = "🟢 Current Source: " + label;
}

// ---- Reading a webpage --------------------------------------------------------

async function handleReadPage() {
  els.readPageBtn.disabled = true;
  showLoading("Scanning page…");
  setPageStatus("Scanning page…", "muted");

  try {
    await ensureContentScriptReady(currentTab.id);
    const response = await sendTabMessage(currentTab.id, { type: MESSAGE_TYPES.READ_PAGE });
    if (!response.ok) throw new Error(response.error || "Could not read this page.");

    const data = response.data;
    if (data.wordCount < MIN_WORD_COUNT) {
      setPageStatus("Not enough readable content was found on this page.", "error");
      showToast("Try opening the main article or study material.");
      return;
    }

    setPageStatus("Page analyzed — ready to study", "sage");
    startNewContentSession({
      sourceType: "page",
      title: data.title,
      meta: data.domain,
      wordCount: data.wordCount,
      textContent: data.textContent,
      preview: data.preview
    });
  } catch (err) {
    handleError(err, "Something went wrong while reading this page. Please try again.");
  } finally {
    hideLoading();
    els.readPageBtn.disabled = false;
  }
}

function ensureContentScriptReady(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, { type: "PING" }, async (response) => {
      if (!chrome.runtime.lastError && response && response.ok) {
        resolve();
        return;
      }
      try {
        await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
        await chrome.scripting.insertCSS({ target: { tabId }, files: ["highlight.css"] });
        resolve();
      } catch (err) {
        reject(new Error("StudyLens lost permission to read this tab. Click the StudyLens icon in your toolbar, then try again."));
      }
    });
  });
}

function sendTabMessage(tabId, message) {
  return new Promise((resolve, reject) => {
    chrome.tabs.sendMessage(tabId, message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "Lost connection to the page."));
        return;
      }
      resolve(response || { ok: false, error: "No response from the page." });
    });
  });
}

function sendRuntimeMessage(message) {
  return new Promise((resolve, reject) => {
    chrome.runtime.sendMessage(message, (response) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message || "Lost connection to StudyLens."));
        return;
      }
      resolve(response || { ok: false, error: "No response from StudyLens." });
    });
  });
}

// ---- Uploading a file --------------------------------------------------------

async function handleFileSelected(file) {
  hide(els.fileInfo);
  showLoading("Uploading…");

  try {
    const parsed = await extractFileContent(file, (message) => setLoadingText(message));

    currentFileMeta = { name: file.name, size: file.size, kind: parsed.kind };
    showFileInfo(currentFileMeta, parsed);

    startNewContentSession({
      sourceType: "file",
      title: file.name,
      meta: buildFileMetaLabel(currentFileMeta, parsed),
      wordCount: parsed.wordCount,
      textContent: parsed.text,
      preview: parsed.text.slice(0, 320)
    });

    if (parsed.truncated) {
      showToast("This file was large - StudyLens read the first part of it. See the file details for specifics.");
    }
    if (parsed.bestEffort) {
      showToast("RTF support is best-effort - some formatting or text may not have extracted perfectly.");
    }
  } catch (err) {
    if (err instanceof FileParseError) {
      showToast(err.message);
    } else {
      handleError(err, "StudyLens couldn't read this file. Please make sure the file isn't corrupted or password-protected.");
    }
  } finally {
    hideLoading();
  }
}

function buildFileMetaLabel(fileMeta, parsed) {
  const parts = [FILE_KIND_LABEL[fileMeta.kind] || fileMeta.kind.toUpperCase(), formatFileSize(fileMeta.size)];
  if (parsed.pages) parts.splice(1, 0, parsed.pages + (parsed.pages === 1 ? " page" : " pages"));
  else if (parsed.slideCount) parts.splice(1, 0, parsed.slideCount + (parsed.slideCount === 1 ? " slide" : " slides"));
  else if (parsed.rowCount) parts.splice(1, 0, parsed.rowCount + (parsed.rowCount === 1 ? " row" : " rows"));
  return parts.join(" • ");
}

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function showFileInfo(fileMeta, parsed) {
  const icon = FILE_KIND_ICON[fileMeta.kind] || "📄";
  els.fileName.textContent = icon + " " + fileMeta.name;
  els.fileMeta.textContent = buildFileMetaLabel(fileMeta, parsed);
  show(els.fileInfo);
}

function handleRemoveFile() {
  currentFileMeta = null;
  hide(els.fileInfo);
  if (activeContent && activeContent.sourceType === "file") {
    resetContentSession();
  }
}

// ---- Shared content session (webpage or file) --------------------------------

function startNewContentSession(content) {
  activeContent = content;
  results = {};
  activeResultKey = null;
  highlightState = { total: 0, current: -1 };

  hide(els.resultSection);
  hide(els.highlightControls);
  hide(els.stickyFooter);
  updatePromptButtonsState();
  updateSourceLabel();

  els.previewWordCount.textContent = content.wordCount.toLocaleString() + " words detected";
  els.previewText.textContent =
    "\u201c" + content.preview.trim() + (content.textContent.length > content.preview.length ? "…" : "") + "\u201d";
  show(els.previewSection);
  hide(els.studyToolsSection);
}

function resetContentSession() {
  activeContent = null;
  results = {};
  activeResultKey = null;
  highlightState = { total: 0, current: -1 };
  hide(els.previewSection);
  hide(els.studyToolsSection);
  hide(els.resultSection);
  hide(els.highlightControls);
  hide(els.stickyFooter);
  updateSourceLabel();
}

// ---- AI generation ------------------------------------------------------------

function confirmAIDisclosureIfNeeded() {
  if (!settings.confirmBeforeAI || aiDisclosureAcknowledgedThisSession) {
    return Promise.resolve(true);
  }
  showOverlay(els.disclosureOverlay);
  return new Promise((resolve) => {
    disclosureResolver = resolve;
  });
}

async function generateAndShow(key, messageType, extra) {
  if (!activeContent) return;

  if (!settings.apiKey) {
    showToast("Add an AI API key in Settings to use this feature.");
    return;
  }
  const proceed = await confirmAIDisclosureIfNeeded();
  if (!proceed) return;

  startLoadingCycle(LOADING_MESSAGES[key] || ["Working…"]);
  setStudyButtonsDisabled(true);

  try {
    const response = await sendRuntimeMessage({
      type: messageType,
      textContent: activeContent.textContent,
      ...(extra || {})
    });
    if (!response.ok) throw new Error(response.error || "The AI service could not generate this.");

    results[key] = { text: response.text, chunked: response.chunked, chunkCount: response.chunkCount };
    activeResultKey = key;
    renderResults();
    updatePromptButtonsState();
  } catch (err) {
    handleError(err, "Something went wrong while generating this. Please try again.");
  } finally {
    hideLoading();
    setStudyButtonsDisabled(false);
  }
}

function setStudyButtonsDisabled(disabled) {
  [els.summarizeBtn, els.keyPointsBtn, els.highlightBtn, els.reviewerBtn].forEach((btn) => {
    btn.disabled = disabled;
  });
}

// ---- Highlighting (webpage source only) ---------------------------------------

async function handleHighlight() {
  if (!activeContent || activeContent.sourceType !== "page") return;

  if (!settings.apiKey) {
    showToast("Add an AI API key in Settings to use this feature.");
    return;
  }
  const proceed = await confirmAIDisclosureIfNeeded();
  if (!proceed) return;

  startLoadingCycle(LOADING_MESSAGES.highlight);
  setStudyButtonsDisabled(true);

  try {
    const aiResponse = await sendRuntimeMessage({
      type: MESSAGE_TYPES.GENERATE_HIGHLIGHT_PHRASES,
      textContent: activeContent.textContent,
      count: 10
    });
    if (!aiResponse.ok) throw new Error(aiResponse.error || "Could not find important passages.");

    const tabResponse = await sendTabMessage(currentTab.id, {
      type: MESSAGE_TYPES.HIGHLIGHT_CONTENT,
      phrases: aiResponse.phrases
    });
    if (!tabResponse.ok) throw new Error(tabResponse.error || "Could not highlight this page.");

    highlightState = { total: tabResponse.total, current: tabResponse.total > 0 ? 0 : -1 };

    if (tabResponse.total === 0) {
      showToast("Could not match the important passages to text on this page.");
      hide(els.highlightControls);
    } else {
      show(els.highlightControls);
      updateHighlightPosition();
      await sendTabMessage(currentTab.id, { type: MESSAGE_TYPES.SCROLL_TO_HIGHLIGHT, index: 0 });
    }
  } catch (err) {
    handleError(err, "Something went wrong while highlighting this page.");
  } finally {
    hideLoading();
    setStudyButtonsDisabled(false);
  }
}

async function moveHighlight(direction) {
  if (highlightState.total === 0) return;
  highlightState.current = (highlightState.current + direction + highlightState.total) % highlightState.total;
  updateHighlightPosition();
  try {
    await sendTabMessage(currentTab.id, { type: MESSAGE_TYPES.SCROLL_TO_HIGHLIGHT, index: highlightState.current });
  } catch (err) {
    handleError(err, "Could not scroll to that highlight.");
  }
}

function updateHighlightPosition() {
  const shown = highlightState.total === 0 ? 0 : highlightState.current + 1;
  els.highlightPosition.textContent = "Highlight " + shown + " of " + highlightState.total;
}

async function handleRemoveHighlights() {
  try {
    await sendTabMessage(currentTab.id, { type: MESSAGE_TYPES.REMOVE_HIGHLIGHTS });
    highlightState = { total: 0, current: -1 };
    hide(els.highlightControls);
  } catch (err) {
    handleError(err, "Could not remove highlights from this page.");
  }
}

// ---- Quiz / flashcard prompts (no AI call - built from existing results) ---------

function bestAvailableStudyMaterial() {
  if (results.reviewer) return results.reviewer.text;
  if (results.summary) return results.summary.text;
  if (results.keyPoints) return results.keyPoints.text;
  return null;
}

function buildPromptResult(key) {
  const material = bestAvailableStudyMaterial();
  if (!material) {
    showToast("Generate a summary or reviewer first.");
    return;
  }
  const text = key === "quizPrompt" ? buildQuizPrompt(material) : buildFlashcardPrompt(material);
  results[key] = { text, chunked: false };
  activeResultKey = key;
  renderResults();
}

function updatePromptButtonsState() {
  const hasMaterial = !!bestAvailableStudyMaterial();
  els.quizPromptBtn.disabled = !hasMaterial;
  els.flashcardPromptBtn.disabled = !hasMaterial;
  els.promptHint.classList.toggle("hidden", hasMaterial);
}

// ---- Results panel ----------------------------------------------------------------

function renderResults() {
  const keys = TAB_ORDER.filter((key) => results[key]);
  if (keys.length === 0) {
    hide(els.resultSection);
    hide(els.stickyFooter);
    return;
  }
  if (!activeResultKey || !results[activeResultKey]) {
    activeResultKey = keys[keys.length - 1];
  }

  els.resultTabs.innerHTML = "";
  keys.forEach((key) => {
    const btn = document.createElement("button");
    btn.className = "tab";
    btn.type = "button";
    btn.dataset.key = key;
    btn.setAttribute("role", "tab");
    btn.setAttribute("aria-selected", String(key === activeResultKey));
    btn.textContent = TAB_LABELS[key];
    els.resultTabs.appendChild(btn);
  });

  const active = results[activeResultKey];
  els.resultText.textContent = active.text;

  if (active.chunked) {
    els.resultChunkNote.textContent =
      "This source was long, so StudyLens combined " + active.chunkCount + " sections to build this result.";
    show(els.resultChunkNote);
  } else {
    hide(els.resultChunkNote);
  }

  els.copyBtn.textContent = "Copy " + TAB_LABELS[activeResultKey];
  show(els.resultSection);
  show(els.stickyFooter);
}

async function handleCopy() {
  const active = results[activeResultKey];
  if (!active) return;
  try {
    await navigator.clipboard.writeText(active.text);
    showToast(TAB_LABELS[activeResultKey] + " copied to clipboard!");
  } catch (err) {
    showToast("Could not copy automatically — please select the text and copy it manually.");
  }
}

function handleRegenerate() {
  if (!activeResultKey) return;
  if (activeResultKey === "summary") generateAndShow("summary", MESSAGE_TYPES.GENERATE_SUMMARY);
  else if (activeResultKey === "keyPoints") generateAndShow("keyPoints", MESSAGE_TYPES.GENERATE_KEY_POINTS);
  else if (activeResultKey === "reviewer") {
    generateAndShow("reviewer", MESSAGE_TYPES.GENERATE_REVIEWER, { reviewerMode: selectedReviewerMode });
  } else {
    buildPromptResult(activeResultKey);
  }
}

function handleClear() {
  if (!activeResultKey) return;
  delete results[activeResultKey];
  activeResultKey = null;
  updatePromptButtonsState();
  renderResults();
}

// ---- Small UI helpers ---------------------------------------------------------------

function show(node) {
  node.classList.remove("hidden");
}
function hide(node) {
  node.classList.add("hidden");
}
function showOverlay(node) {
  node.classList.remove("hidden");
}
function hideOverlay(node) {
  node.classList.add("hidden");
}

function setPageStatus(text, variant) {
  els.pageStatus.textContent = text;
  els.pageStatus.classList.remove("status-error", "status-muted");
  if (variant === "error") els.pageStatus.classList.add("status-error");
  if (variant === "muted") els.pageStatus.classList.add("status-muted");
}

// Used for file extraction: reflects the parser's real, current step
// rather than a rotating guess (see README > Progress Indicators).
function showLoading(message) {
  setLoadingText(message);
  show(els.loadingCard);
}
function setLoadingText(message) {
  els.loadingMessage.textContent = message;
  show(els.loadingCard);
}

// Used for AI generation calls, where StudyLens has no real progress
// signal to report - a short rotating list of plausible steps instead of
// one static "Loading…" (matches the original popup's behavior).
let loadingCycleIntervalId = null;
function startLoadingCycle(messages) {
  let i = 0;
  setLoadingText(messages[0]);
  if (messages.length > 1) {
    loadingCycleIntervalId = setInterval(() => {
      i = (i + 1) % messages.length;
      setLoadingText(messages[i]);
    }, 1300);
  }
}

function hideLoading() {
  if (loadingCycleIntervalId) {
    clearInterval(loadingCycleIntervalId);
    loadingCycleIntervalId = null;
  }
  hide(els.loadingCard);
}

function showToast(message) {
  els.toast.textContent = message;
  show(els.toast);
  clearTimeout(toastTimeoutId);
  toastTimeoutId = setTimeout(() => hide(els.toast), 3200);
}

// Never show raw JavaScript errors to the student - only the friendly
// message our own code constructs, or a generic fallback otherwise.
function handleError(err, fallbackMessage) {
  console.error("StudyLens error:", err);
  const message = err && err.message ? err.message : "";
  const looksTechnical = /TypeError|undefined|null is not|Cannot read|ReferenceError/.test(message);
  showToast(!message || looksTechnical ? fallbackMessage : message);
}
