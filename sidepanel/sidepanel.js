/*
  sidepanel.js
  ------------
  Drives the StudyLens side panel:
    - content.js on the active tab, for reading pages and highlighting
    - fileParser.js, for turning an uploaded file into text (locally)
    - aiService.js, for every AI request (made from this page - see the
      note at the top of aiService.js for why)
    - markdown.js + studyModes.js, for showing results

  A scanned webpage, an uploaded file, and right-click-selected text all
  become the same shape - state.content - so every study tool works the
  same way regardless of where the text came from. Only highlighting is
  webpage-only, since it needs the live page.

  The session (source + results) is saved to chrome.storage.session, which
  Chrome keeps in memory only: closing and reopening the panel picks up
  where you left off, and closing the browser clears it.
*/

const UNSUPPORTED_URL_PATTERNS = [
  /^chrome:\/\//, /^chrome-extension:\/\//, /^chrome-search:\/\//, /^chrome-untrusted:\/\//, /^devtools:\/\//,
  /^edge:\/\//, /^brave:\/\//, /^opera:\/\//, /^vivaldi:\/\//, /^about:/, /^view-source:/, /^data:/,
  /^https:\/\/chrome\.google\.com\/webstore/, /^https:\/\/chromewebstore\.google\.com/,
  /^https:\/\/microsoftedge\.microsoft\.com\/addons/
];

const SITE_HINTS = [
  {
    pattern: /^https:\/\/docs\.google\.com\/(document|presentation|spreadsheets)\//,
    hint: "Google Docs draws its text in a way extensions can't read. Use File → Download (.docx, .pptx, or .pdf), then upload it in the File tab."
  }
];

const VIEW_INFO = {
  summary: { label: "Summary", icon: "summary", kind: "text" },
  keyPoints: { label: "Key Points", icon: "keypoints", kind: "text" },
  reviewer: { label: "Reviewer", icon: "book", kind: "text" },
  quiz: { label: "Quiz", icon: "quiz", kind: "quiz" },
  flashcards: { label: "Flashcards", icon: "cards", kind: "flashcards" },
  ask: { label: "Ask", icon: "chat", kind: "ask" }
};
const VIEW_ORDER = Object.keys(VIEW_INFO);

const WORKING_TEXT = {
  summary: "Writing your summary…",
  keyPoints: "Picking out the key points…",
  reviewer: "Building your reviewer…",
  quiz: "Writing quiz questions…",
  flashcards: "Making flashcards…",
  ask: "Thinking…",
  highlight: "Finding the most important passages…"
};

const ASK_SUGGESTIONS = [
  "Explain the main idea in simple terms",
  "What are the most likely exam questions?",
  "Give me a real-world example",
  "What's easy to mix up here?"
];

const REVIEWER_MODE_LABEL = { quick: "Quick", standard: "Standard", comprehensive: "Comprehensive" };
const FILE_KIND_LABEL = { pdf: "PDF", docx: "Word", pptx: "PowerPoint", txt: "Text", md: "Markdown", csv: "CSV", rtf: "RTF", html: "HTML" };
const FILE_KIND_ICON = { pptx: "slides", csv: "sheet" };
const WORDS_PER_MINUTE = 220;
const HIGHLIGHT_COUNT = 12;

// ---- State ---------------------------------------------------------------

const state = {
  settings: normalizeSettings(null),
  windowId: null,
  tab: null, // the active tab in this window
  allSitesAccess: false,
  content: null, // { sourceType: "page"|"file"|"selection", title, meta, url, tabId, kind, wordCount, textContent, notice }
  results: {}, // summary | keyPoints | reviewer -> { text, chunkCount, mode, streaming, stopped }
  quiz: null,
  flashcards: null,
  chat: [], // { role, content, streaming?, error?, stopped? }
  activeView: null,
  highlight: { total: 0, current: -1, items: [], tabId: null },
  job: null, // { view, controller, stage }
  sessionSeq: 0, // bumps on every new session so late replies from an old one are ignored
  pendingAction: null,
  lastActionAt: 0,
  disclosureAcknowledged: false
};

// ---- DOM references --------------------------------------------------------

const $ = (id) => document.getElementById(id);

const els = {
  appShell: document.querySelector(".app-shell"),
  appScroll: $("app-scroll"),
  themeBtn: $("theme-btn"),
  settingsBtn: $("settings-btn"),

  setupBanner: $("setup-banner"),
  setupBtn: $("setup-btn"),

  seg: document.querySelector(".seg"),
  sourceTabPage: $("source-tab-page"),
  sourceTabFile: $("source-tab-file"),
  sourcePanelPage: $("source-panel-page"),
  sourcePanelFile: $("source-panel-file"),

  pageFavicon: $("page-favicon"),
  pageFaviconFallback: $("page-favicon-fallback"),
  pageTitle: $("page-title"),
  pageDomain: $("page-domain"),
  pageStatus: $("page-status"),
  readPageBtn: $("read-page-btn"),
  readPageLabel: $("read-page-label"),
  grantAccessBtn: $("grant-access-btn"),

  fileDropZone: $("file-drop-zone"),
  fileInput: $("file-input"),
  extractProgress: $("extract-progress"),
  extractProgressFill: $("extract-progress-fill"),
  extractProgressText: $("extract-progress-text"),

  emptyState: $("empty-state"),

  contentCard: $("content-card"),
  contentIcon: $("content-icon"),
  contentTitle: $("content-title"),
  contentMeta: $("content-meta"),
  contentChips: $("content-chips"),
  contentNotice: $("content-notice"),
  previewText: $("preview-text"),
  closeContentBtn: $("close-content-btn"),
  exportAllBtn: $("export-all-btn"),

  toolsCard: $("tools-card"),
  toolButtons: Array.from(document.querySelectorAll(".tool")),
  reviewerModeGroup: $("reviewer-mode-group"),
  highlightPanel: $("highlight-panel"),
  highlightPrevBtn: $("highlight-prev-btn"),
  highlightNextBtn: $("highlight-next-btn"),
  highlightPosition: $("highlight-position"),
  highlightList: $("highlight-list"),
  removeHighlightsBtn: $("remove-highlights-btn"),
  quizPromptBtn: $("quiz-prompt-btn"),
  flashcardPromptBtn: $("flashcard-prompt-btn"),

  resultCard: $("result-card"),
  resultTabs: $("result-tabs"),
  resultNote: $("result-note"),
  viewText: $("view-text"),
  viewQuiz: $("view-quiz"),
  viewFlashcards: $("view-flashcards"),
  viewAsk: $("view-ask"),

  working: $("working"),
  workingText: $("working-text"),
  workingMeter: $("working-meter"),
  workingFill: $("working-fill"),
  cancelBtn: $("cancel-btn"),

  toTopBtn: $("to-top-btn"),
  footer: $("app-footer"),
  footerActions: $("footer-actions"),
  copyBtn: $("copy-btn"),
  copyLabel: $("copy-label"),
  downloadBtn: $("download-btn"),
  regenerateBtn: $("regenerate-btn"),
  deleteBtn: $("delete-btn"),
  askForm: $("ask-form"),
  askInput: $("ask-input"),
  askSendBtn: $("ask-send-btn"),

  onboardingOverlay: $("onboarding-overlay"),
  onboardingDismiss: $("onboarding-dismiss"),
  onboardingSettings: $("onboarding-settings"),

  dialogOverlay: $("dialog-overlay"),
  dialogTitle: $("dialog-title"),
  dialogBody: $("dialog-body"),
  dialogCheckRow: $("dialog-check-row"),
  dialogCheck: $("dialog-check"),
  dialogCheckLabel: $("dialog-check-label"),
  dialogCancel: $("dialog-cancel"),
  dialogConfirm: $("dialog-confirm"),

  toastStack: $("toast-stack")
};

// ---- Init ------------------------------------------------------------------

init();

async function init() {
  els.fileInput.accept = FILE_SUPPORT.acceptAttr;
  attachEventListeners();

  await loadSettings();
  try {
    state.windowId = (await chrome.windows.getCurrent()).id;
  } catch (err) {
    state.windowId = null;
  }
  await refreshAccess();
  await loadCurrentTab();
  await restoreSession();

  watchTabs();
  watchStorage();
  await maybeShowOnboarding();
  await checkPendingAction();
}

// ---- Settings & appearance ----------------------------------------------------

const darkSchemeQuery = window.matchMedia("(prefers-color-scheme: dark)");

async function loadSettings() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  applySettings(normalizeSettings(stored[STORAGE_KEYS.SETTINGS]));
}

function applySettings(settings) {
  state.settings = settings;
  applyAppearance();
  applyReviewerModeUI();
  updateSetupBanner();
}

// Reads the latest stored settings before writing, so a change made on the
// Settings page (e.g. a new API key) is never overwritten by this panel.
async function updateSettings(patch) {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  const next = { ...normalizeSettings(stored[STORAGE_KEYS.SETTINGS]), ...patch };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: next });
  applySettings(next);
}

function resolvedTheme() {
  const theme = state.settings.theme;
  if (theme === "light" || theme === "dark") return theme;
  return darkSchemeQuery.matches ? "dark" : "light";
}

function applyAppearance() {
  const root = document.documentElement;
  if (state.settings.theme === "system") delete root.dataset.theme;
  else root.dataset.theme = state.settings.theme;
  root.dataset.resolvedTheme = resolvedTheme();
  root.dataset.textSize = state.settings.textSize;
  els.themeBtn.setAttribute("aria-label", resolvedTheme() === "dark" ? "Switch to light mode" : "Switch to dark mode");
  els.themeBtn.title = els.themeBtn.getAttribute("aria-label");
}

darkSchemeQuery.addEventListener("change", applyAppearance);

function updateSetupBanner() {
  els.setupBanner.classList.toggle("hidden", !!activeApiKey(state.settings));
}

function applyReviewerModeUI() {
  els.reviewerModeGroup.querySelectorAll(".pill").forEach((btn) => {
    btn.setAttribute("aria-checked", String(btn.dataset.mode === state.settings.reviewerMode));
  });
}

function watchStorage() {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === "local" && changes[STORAGE_KEYS.SETTINGS]) {
      applySettings(normalizeSettings(changes[STORAGE_KEYS.SETTINGS].newValue));
    }
    if (area === "session" && changes[STORAGE_KEYS.PENDING_ACTION] && changes[STORAGE_KEYS.PENDING_ACTION].newValue) {
      checkPendingAction();
    }
  });
}

async function maybeShowOnboarding() {
  const stored = await chrome.storage.local.get(STORAGE_KEYS.ONBOARDING_SEEN);
  if (!stored[STORAGE_KEYS.ONBOARDING_SEEN]) show(els.onboardingOverlay);
}

async function finishOnboarding(openSettings) {
  hide(els.onboardingOverlay);
  await chrome.storage.local.set({ [STORAGE_KEYS.ONBOARDING_SEEN]: true });
  if (openSettings) chrome.runtime.openOptionsPage();
  if (state.pendingAction) {
    const action = state.pendingAction;
    state.pendingAction = null;
    runPendingAction(action);
  }
}

// ---- Current tab ---------------------------------------------------------------

async function refreshAccess() {
  try {
    state.allSitesAccess = await chrome.permissions.contains({ origins: ["<all_urls>"] });
  } catch (err) {
    state.allSitesAccess = false;
  }
}

async function loadCurrentTab() {
  let tab = null;
  try {
    const query = state.windowId !== null ? { active: true, windowId: state.windowId } : { active: true, currentWindow: true };
    [tab] = await chrome.tabs.query(query);
  } catch (err) {
    tab = null;
  }
  state.tab = tab || null;
  renderPageSource();
}

function isPdfUrl(url) {
  return /^(https?|file):\/\/[^?#]+\.pdf([?#]|$)/i.test(url || "");
}

function sameDocument(a, b) {
  return !!a && !!b && a.split("#")[0] === b.split("#")[0];
}

function renderPageSource() {
  const tab = state.tab;
  hide(els.grantAccessBtn);
  setFavicon(tab && tab.url ? tab.favIconUrl : "");

  els.readPageBtn.disabled = !tab;
  els.readPageLabel.textContent = scanLabel();

  if (!tab || !tab.url) {
    // Chrome only shares a tab's address with StudyLens after the toolbar
    // icon is clicked on that tab (activeTab), or with all-sites access.
    // Scanning may still work, so the button stays enabled.
    els.pageTitle.textContent = "This tab";
    els.pageDomain.textContent = "";
    setPageStatus("If scanning doesn't work, click the StudyLens toolbar icon while you're on this tab, then try again.", "info");
    if (tab && !state.allSitesAccess) show(els.grantAccessBtn);
    return;
  }

  els.pageTitle.textContent = tab.title || "Untitled page";
  els.pageDomain.textContent = hostnameOf(tab.url);

  if (UNSUPPORTED_URL_PATTERNS.some((pattern) => pattern.test(tab.url))) {
    setPageStatus("Chrome doesn't let extensions read this kind of page. Open a normal webpage, or use the File tab.", "error");
    els.readPageBtn.disabled = true;
    return;
  }

  const hint = SITE_HINTS.find((h) => h.pattern.test(tab.url));
  if (hint) {
    setPageStatus(hint.hint, "info");
    return;
  }

  if (isStudyingCurrentTab()) {
    setPageStatus("You're studying this page.", "success");
    return;
  }

  hidePageStatus();
}

function isStudyingCurrentTab() {
  const tab = state.tab;
  return !!(tab && tab.url && state.content && state.content.sourceType === "page" && sameDocument(state.content.url, tab.url));
}

function scanLabel() {
  const url = state.tab && state.tab.url;
  if (isPdfUrl(url)) return "Read this PDF";
  return isStudyingCurrentTab() ? "Rescan this page" : "Scan this page";
}

function setFavicon(url) {
  if (url && !/^chrome:/.test(url)) {
    els.pageFavicon.onerror = () => {
      hide(els.pageFavicon);
      show(els.pageFaviconFallback);
    };
    els.pageFavicon.src = url;
    show(els.pageFavicon);
    hide(els.pageFaviconFallback);
  } else {
    hide(els.pageFavicon);
    show(els.pageFaviconFallback);
  }
}

function watchTabs() {
  chrome.tabs.onActivated.addListener(({ windowId }) => {
    if (state.windowId === null || windowId === state.windowId) loadCurrentTab();
  });

  chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
    if (state.tab && tabId === state.tab.id && (changeInfo.status === "complete" || changeInfo.url || changeInfo.title || changeInfo.favIconUrl)) {
      loadCurrentTab();
    }
    // A reload or navigation wipes the page's highlights.
    if (changeInfo.status === "loading" && state.highlight.tabId === tabId) {
      clearHighlightState();
    }
  });

  chrome.tabs.onRemoved.addListener((tabId) => {
    if (state.highlight.tabId === tabId) clearHighlightState();
  });

  chrome.permissions.onAdded.addListener(async () => {
    await refreshAccess();
    loadCurrentTab();
  });
  chrome.permissions.onRemoved.addListener(async () => {
    await refreshAccess();
    loadCurrentTab();
  });
}

async function requestAllSitesAccess() {
  let granted = false;
  try {
    granted = await chrome.permissions.request({ origins: ["<all_urls>"] });
  } catch (err) {
    granted = false;
  }
  if (granted) {
    state.allSitesAccess = true;
    showToast("Done - StudyLens can read any tab when you click Scan. It still never reads a page on its own.", "success");
    await loadCurrentTab();
  }
}

// ---- Event wiring -----------------------------------------------------------

function attachEventListeners() {
  els.onboardingDismiss.addEventListener("click", () => finishOnboarding(false));
  els.onboardingSettings.addEventListener("click", () => finishOnboarding(true));

  els.dialogConfirm.addEventListener("click", () => closeDialog(true));
  els.dialogCancel.addEventListener("click", () => closeDialog(false));
  els.dialogOverlay.addEventListener("click", (e) => {
    if (e.target === els.dialogOverlay) closeDialog(false);
  });

  els.settingsBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  els.setupBtn.addEventListener("click", () => chrome.runtime.openOptionsPage());
  els.themeBtn.addEventListener("click", () => updateSettings({ theme: resolvedTheme() === "dark" ? "light" : "dark" }));

  els.sourceTabPage.addEventListener("click", () => setSourceTab("page"));
  els.sourceTabFile.addEventListener("click", () => setSourceTab("file"));

  els.readPageBtn.addEventListener("click", handleScanPage);
  els.grantAccessBtn.addEventListener("click", requestAllSitesAccess);

  els.fileDropZone.addEventListener("click", () => els.fileInput.click());
  els.fileDropZone.addEventListener("keydown", (e) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      els.fileInput.click();
    }
  });
  els.fileInput.addEventListener("change", () => {
    const file = els.fileInput.files && els.fileInput.files[0];
    els.fileInput.value = ""; // allow re-selecting the same file later
    if (file) handleFileSelected(file);
  });
  attachDragAndDrop();

  els.closeContentBtn.addEventListener("click", closeSession);
  els.exportAllBtn.addEventListener("click", downloadStudyPack);

  els.toolButtons.forEach((btn) => btn.addEventListener("click", () => handleToolClick(btn.dataset.tool)));

  els.reviewerModeGroup.addEventListener("click", (event) => {
    const btn = event.target.closest(".pill");
    if (btn) updateSettings({ reviewerMode: btn.dataset.mode });
  });

  els.highlightPrevBtn.addEventListener("click", () => moveHighlight(-1));
  els.highlightNextBtn.addEventListener("click", () => moveHighlight(1));
  els.removeHighlightsBtn.addEventListener("click", removeHighlights);
  els.highlightList.addEventListener("click", (event) => {
    const btn = event.target.closest("button[data-index]");
    if (btn) jumpToHighlight(Number(btn.dataset.index));
  });

  els.quizPromptBtn.addEventListener("click", () => copyExternalPrompt("quiz"));
  els.flashcardPromptBtn.addEventListener("click", () => copyExternalPrompt("flashcards"));

  els.resultTabs.addEventListener("click", (event) => {
    const btn = event.target.closest(".rtab");
    if (btn) openView(btn.dataset.view, { scroll: false });
  });
  els.viewText.addEventListener("click", (event) => {
    const link = event.target.closest("a[data-target]");
    if (!link) return;
    event.preventDefault();
    const target = document.getElementById(link.dataset.target);
    if (target) target.scrollIntoView({ behavior: "smooth", block: "start" });
  });

  els.cancelBtn.addEventListener("click", () => stopJob(true));

  els.copyBtn.addEventListener("click", copyActive);
  els.downloadBtn.addEventListener("click", downloadActive);
  els.regenerateBtn.addEventListener("click", regenerateActive);
  els.deleteBtn.addEventListener("click", deleteActive);

  els.askForm.addEventListener("submit", (e) => {
    e.preventDefault();
    sendQuestion(els.askInput.value);
  });
  els.askInput.addEventListener("keydown", (e) => {
    if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendQuestion(els.askInput.value);
    }
  });
  els.askInput.addEventListener("input", autosizeAskInput);

  els.appScroll.addEventListener("scroll", () => {
    els.toTopBtn.classList.toggle("is-visible", els.appScroll.scrollTop > 500);
  });
  els.toTopBtn.addEventListener("click", () => els.appScroll.scrollTo({ top: 0, behavior: "smooth" }));

  document.addEventListener("keydown", handleGlobalKeys);
}

function handleGlobalKeys(event) {
  if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey) return;

  if (!els.dialogOverlay.classList.contains("hidden")) {
    if (event.key === "Escape") closeDialog(false);
    return;
  }
  if (!els.onboardingOverlay.classList.contains("hidden")) {
    if (event.key === "Escape") finishOnboarding(false);
    return;
  }
  if (event.target.closest("input, textarea, select, [contenteditable='true']")) return;
  // Let Space/Enter activate whatever button has focus, as usual.
  if ((event.key === " " || event.key === "Enter") && event.target.closest("button, a, summary")) return;
  if (els.resultCard.classList.contains("hidden")) return;

  const handled =
    (state.activeView === "quiz" && StudyModes.handleQuizKey(event, els.viewQuiz)) ||
    (state.activeView === "flashcards" && StudyModes.handleFlashcardKey(event, els.viewFlashcards));
  if (handled) event.preventDefault();
}

// Dropping a file anywhere on the panel loads it (and stops Chrome from
// navigating the panel to the dropped file, which it does by default).
function attachDragAndDrop() {
  let depth = 0;
  const hasFiles = (e) => e.dataTransfer && Array.from(e.dataTransfer.types || []).includes("Files");
  const inTextField = (e) => e.target.closest && e.target.closest("textarea, input");

  document.addEventListener("dragenter", (e) => {
    if (!hasFiles(e)) return;
    e.preventDefault();
    depth += 1;
    els.appShell.classList.add("is-file-over");
    els.fileDropZone.classList.add("is-dragging");
  });
  document.addEventListener("dragover", (e) => {
    if (inTextField(e) && !hasFiles(e)) return;
    e.preventDefault();
    if (hasFiles(e)) e.dataTransfer.dropEffect = "copy";
  });
  document.addEventListener("dragleave", (e) => {
    if (!hasFiles(e)) return;
    depth = Math.max(0, depth - 1);
    if (!depth) {
      els.appShell.classList.remove("is-file-over");
      els.fileDropZone.classList.remove("is-dragging");
    }
  });
  document.addEventListener("drop", (e) => {
    if (inTextField(e) && !hasFiles(e)) return;
    e.preventDefault();
    depth = 0;
    els.appShell.classList.remove("is-file-over");
    els.fileDropZone.classList.remove("is-dragging");
    const file = hasFiles(e) && e.dataTransfer.files[0];
    if (file) {
      setSourceTab("file");
      handleFileSelected(file);
    }
  });
}

// ---- Source switching --------------------------------------------------------

function setSourceTab(tab) {
  els.seg.dataset.active = tab;
  els.sourceTabPage.setAttribute("aria-selected", String(tab === "page"));
  els.sourceTabFile.setAttribute("aria-selected", String(tab === "file"));
  els.sourcePanelPage.classList.toggle("hidden", tab !== "page");
  els.sourcePanelFile.classList.toggle("hidden", tab !== "file");
}

// ---- Reading a webpage --------------------------------------------------------

async function handleScanPage() {
  const tab = state.tab;
  if (!tab) return;
  if (state.job) {
    showToast("Wait for the current task to finish, or stop it first.");
    return;
  }
  if (!(await confirmReplaceSession())) return;
  if (isPdfUrl(tab.url)) return readPdfFromTab(tab);

  setScanBusy(true, "Scanning…");
  try {
    await ensureContentScript(tab.id, tab.url);
    const response = await chrome.tabs.sendMessage(tab.id, { type: MESSAGE_TYPES.READ_PAGE });
    if (!response || !response.ok) throw new Error((response && response.error) || "Could not read this page.");

    const data = response.data;
    if (data.wordCount < MIN_WORD_COUNT) {
      setPageStatus(
        "Only " + data.wordCount + " words of readable text were found here. Open the main article or study material, or try the File tab.",
        "error"
      );
      return;
    }

    startSession({
      sourceType: "page",
      title: data.title,
      meta: data.domain,
      url: data.url,
      tabId: tab.id,
      wordCount: data.wordCount,
      textContent: data.textContent
    });
    loadCurrentTab(); // the scan may have just made the tab's address visible
  } catch (err) {
    setPageStatus(friendlyMessage(err, "Something went wrong while reading this page. Reload the page and try again."), "error");
  } finally {
    setScanBusy(false);
  }
}

// Leaves the status line alone, so an error from the scan stays visible.
function setScanBusy(busy, label) {
  els.readPageBtn.disabled = busy;
  els.readPageBtn.classList.toggle("is-loading", busy);
  els.readPageLabel.textContent = busy ? label : scanLabel();
}

async function ensureContentScript(tabId, url) {
  try {
    const pong = await chrome.tabs.sendMessage(tabId, { type: MESSAGE_TYPES.PING });
    if (pong && pong.ok) return;
  } catch (err) {
    // No content script yet - inject it below.
  }

  try {
    await chrome.scripting.insertCSS({ target: { tabId }, files: ["highlight.css"] });
    await chrome.scripting.executeScript({ target: { tabId }, files: ["content.js"] });
  } catch (err) {
    const message = (err && err.message) || "";
    if (/^file:/.test(url || "")) {
      throw new Error('To read files opened in Chrome, turn on "Allow access to file URLs" for StudyLens at chrome://extensions - or upload the file in the File tab.');
    }
    if (/cannot be scripted|extensions gallery/i.test(message)) {
      throw new Error("Chrome doesn't let extensions read this page. Try another page, or use the File tab.");
    }
    if (!state.allSitesAccess) show(els.grantAccessBtn);
    throw new Error("StudyLens doesn't have permission to read this tab right now. Click the StudyLens toolbar icon on this tab, then scan again.");
  }
}

// PDFs open in Chrome's built-in viewer, which extensions can't read - so
// StudyLens downloads the file itself and reads it like an upload.
async function readPdfFromTab(tab) {
  setScanBusy(true, "Downloading PDF…");
  let blob;
  try {
    const response = await fetch(tab.url, { credentials: "include" });
    if (!response.ok) throw new Error("HTTP " + response.status);
    blob = await response.blob();
  } catch (err) {
    setScanBusy(false);
    if (/^file:/.test(tab.url)) {
      setPageStatus('Chrome blocks extensions from opening local files unless "Allow access to file URLs" is on for StudyLens (chrome://extensions). Or upload the PDF in the File tab.', "error");
    } else {
      setPageStatus("StudyLens couldn't download this PDF. Allow access below, or save the PDF and upload it in the File tab.", "error");
      if (!state.allSitesAccess) show(els.grantAccessBtn);
    }
    return;
  }
  setScanBusy(false);

  let name = "document.pdf";
  try {
    name = decodeURIComponent(new URL(tab.url).pathname.split("/").pop()) || name;
  } catch (err) {
    // keep the default name
  }
  await handleFileSelected(new File([blob], name, { type: "application/pdf" }), { fromTab: tab, skipConfirm: true });
}

// ---- Uploading a file --------------------------------------------------------

async function handleFileSelected(file, options) {
  const opts = options || {};
  if (state.job) {
    showToast("Wait for the current task to finish, or stop it first.");
    return;
  }
  if (!opts.skipConfirm && !(await confirmReplaceSession())) return;

  showExtractProgress("Opening " + file.name + "…", null);
  try {
    const parsed = await extractFileContent(file, (message, fraction) => showExtractProgress(message, fraction));
    const fromTab = opts.fromTab;

    const parts = [FILE_KIND_LABEL[parsed.kind] || parsed.kind.toUpperCase(), formatFileSize(file.size)];
    if (fromTab) parts.push("from " + hostnameOf(fromTab.url));

    startSession({
      sourceType: "file",
      kind: parsed.kind,
      title: file.name,
      meta: parts.join(" · "),
      url: fromTab ? fromTab.url : "",
      pages: parsed.pages,
      slideCount: parsed.slideCount,
      rowCount: parsed.rowCount,
      wordCount: parsed.wordCount,
      textContent: parsed.text,
      notice: parsed.truncated
        ? "Large spreadsheet: StudyLens read the first 500 rows."
        : parsed.bestEffort
        ? "RTF support is best-effort, so some text may be missing. DOCX or PDF works best."
        : ""
    });
    showToast("Ready! Pick a study tool below.", "success");
  } catch (err) {
    handleError(err, "StudyLens couldn't read this file. Make sure it isn't corrupted or password-protected.");
  } finally {
    hideExtractProgress();
  }
}

function showExtractProgress(message, fraction) {
  show(els.extractProgress);
  els.extractProgressText.textContent = message;
  const meter = els.extractProgressFill.parentElement;
  meter.classList.toggle("is-indeterminate", typeof fraction !== "number");
  if (typeof fraction === "number") els.extractProgressFill.style.width = Math.round(fraction * 100) + "%";
}

function hideExtractProgress() {
  hide(els.extractProgress);
  els.extractProgressFill.style.width = "0";
}

// ---- Study session ---------------------------------------------------------------

function hasStudyWork() {
  return Object.keys(state.results).length > 0 || !!state.quiz || !!state.flashcards || state.chat.length > 0;
}

async function confirmReplaceSession() {
  if (!state.content || !hasStudyWork()) return true;
  const answer = await confirmDialog({
    title: "Start a new study session?",
    body:
      "Your results for “" + state.content.title + "” will be cleared. " +
      "Use “Download study pack” first if you want to keep them.",
    confirmLabel: "Start new session"
  });
  return answer.confirmed;
}

function startSession(content) {
  stopJob(false);
  removeHighlightsQuietly();
  state.sessionSeq += 1;
  state.content = { ...content, createdAt: Date.now() };
  state.results = {};
  state.quiz = null;
  state.flashcards = null;
  state.chat = [];
  state.activeView = null;
  renderAll();
  persistSession();
  requestAnimationFrame(() => els.contentCard.scrollIntoView({ behavior: "smooth", block: "start" }));
}

async function closeSession() {
  if (hasStudyWork()) {
    const answer = await confirmDialog({
      title: "Close this source?",
      body: "Your summary, quiz, flashcards, and other results for “" + state.content.title + "” will be cleared.",
      confirmLabel: "Close source"
    });
    if (!answer.confirmed) return;
  }
  stopJob(false);
  removeHighlightsQuietly();
  state.sessionSeq += 1;
  state.content = null;
  state.results = {};
  state.quiz = null;
  state.flashcards = null;
  state.chat = [];
  state.activeView = null;
  renderAll();
  persistSession();
}

function renderAll() {
  renderContentCard();
  renderTools();
  renderHighlightPanel();
  renderResults();
  renderPageSource();
  els.emptyState.classList.toggle("hidden", !!state.content);
}

function renderContentCard() {
  const content = state.content;
  if (!content) {
    hide(els.contentCard);
    return;
  }

  const iconName =
    content.sourceType === "page" ? "globe" : content.sourceType === "selection" ? "quote" : FILE_KIND_ICON[content.kind] || "file";
  els.contentIcon.innerHTML = iconSvg(iconName);
  els.contentTitle.textContent = content.title;
  els.contentTitle.title = content.title;
  els.contentMeta.textContent =
    content.sourceType === "selection" ? "Selected text · " + (content.meta || "") : content.meta || "";

  const chips = [
    content.wordCount.toLocaleString() + " words",
    "~" + Math.max(1, Math.round(content.wordCount / WORDS_PER_MINUTE)) + " min read"
  ];
  if (content.pages) chips.push(content.pages + (content.pages === 1 ? " page" : " pages"));
  if (content.slideCount) chips.push(content.slideCount + (content.slideCount === 1 ? " slide" : " slides"));
  if (content.rowCount) chips.push(content.rowCount.toLocaleString() + " rows");
  if (content.textContent.length > MAX_CHARS_PER_CHUNK) {
    chips.push(Math.ceil(content.textContent.length / MAX_CHARS_PER_CHUNK) + "+ parts");
  }
  els.contentChips.innerHTML = chips.map((c) => '<span class="chip">' + Markdown.escapeHtml(c) + "</span>").join("");

  els.contentNotice.textContent = content.notice || "";
  els.contentNotice.classList.toggle("hidden", !content.notice);

  const preview = content.textContent.slice(0, 1500);
  els.previewText.textContent = preview + (content.textContent.length > preview.length ? "…" : "");
  els.exportAllBtn.classList.toggle("hidden", !hasStudyWork());
  reveal(els.contentCard);
}

function renderTools() {
  if (!state.content) {
    hide(els.toolsCard);
    return;
  }
  reveal(els.toolsCard);

  const isPage = state.content.sourceType === "page";
  els.toolButtons.forEach((btn) => {
    const tool = btn.dataset.tool;
    if (tool === "highlight") btn.classList.toggle("hidden", !isPage);
    const running = !!state.job && state.job.view === tool;
    btn.classList.toggle("is-running", running);
    btn.classList.toggle("is-done", !running && toolHasResult(tool));
    btn.disabled = !!state.job && !running;
  });
}

function toolHasResult(tool) {
  if (tool === "highlight") return state.highlight.total > 0;
  if (tool === "ask") return state.chat.length > 0;
  return hasView(tool);
}

// ---- Session persistence (chrome.storage.session - memory only) -----------------

function sessionKey() {
  // One session per browser window, since each window has its own panel.
  return STORAGE_KEYS.SESSION + ":" + (state.windowId === null ? "default" : state.windowId);
}

let persistTimer = 0;
function persistSession() {
  clearTimeout(persistTimer);
  persistTimer = setTimeout(saveSession, 400);
}

async function saveSession() {
  try {
    if (!state.content) {
      await chrome.storage.session.remove(sessionKey());
      return;
    }
    const results = {};
    Object.entries(state.results).forEach(([key, value]) => {
      if (!value.streaming) results[key] = value;
    });
    await chrome.storage.session.set({
      [sessionKey()]: {
        content: state.content,
        results,
        quiz: state.quiz,
        flashcards: state.flashcards,
        chat: state.chat.filter((m) => !m.streaming),
        activeView: state.activeView
      }
    });
  } catch (err) {
    console.warn("StudyLens: couldn't save this session (it may be too large to keep).", err);
  }
}

async function restoreSession() {
  let snapshot = null;
  try {
    snapshot = (await chrome.storage.session.get(sessionKey()))[sessionKey()];
  } catch (err) {
    snapshot = null;
  }

  if (snapshot && snapshot.content) {
    state.content = snapshot.content;
    state.results = snapshot.results || {};
    state.quiz = snapshot.quiz || null;
    state.flashcards = snapshot.flashcards || null;
    state.chat = snapshot.chat || [];
    state.activeView = snapshot.activeView || null;
    if (state.content.sourceType === "file") setSourceTab("file");
  }
  renderAll();
  if (state.content && state.content.sourceType === "page") refreshHighlightStatus();
}

// ---- AI jobs --------------------------------------------------------------------

function makeAI(signal) {
  return {
    provider: state.settings.aiProvider,
    apiKey: activeApiKey(state.settings),
    model: activeModel(state.settings),
    language: state.settings.outputLanguage,
    signal,
    onRetry: (attempt, err) =>
      setWorking({ text: (err.code === "rate-limit" ? "Rate-limited - retrying" : "Retrying") + " (attempt " + (attempt + 1) + ")…" })
  };
}

async function ensureAIReady() {
  if (!activeApiKey(state.settings)) {
    show(els.setupBanner);
    els.setupBanner.classList.remove("attention");
    void els.setupBanner.offsetWidth;
    els.setupBanner.classList.add("attention");
    els.appScroll.scrollTo({ top: 0, behavior: "smooth" });
    showToast("Add an API key in Settings to use the AI study tools.", "info", {
      action: { label: "Settings", onClick: () => chrome.runtime.openOptionsPage() }
    });
    return false;
  }

  if (state.settings.confirmBeforeAI && !state.disclosureAcknowledged) {
    const provider = AI_PROVIDER_INFO[state.settings.aiProvider];
    const answer = await confirmDialog({
      title: "Send this to " + provider.label + "?",
      body:
        "To create study materials, StudyLens sends the extracted text (about " +
        state.content.wordCount.toLocaleString() + " words of “" + state.content.title + "”) to " +
        provider.label + " using your API key. It isn't sent anywhere else.",
      confirmLabel: "Continue",
      checkboxLabel: "Don't ask again (you can change this in Settings)"
    });
    if (!answer.confirmed) return false;
    state.disclosureAcknowledged = true;
    if (answer.checked) await updateSettings({ confirmBeforeAI: false });
  }
  return true;
}

// Runs one AI task at a time. `prepare` runs once the student has passed
// the key/disclosure checks; `work` does the request; `onError` lets the
// caller put things back if it fails or is stopped.
async function runJob(view, work, hooks) {
  const options = hooks || {};
  if (!state.content) return false;
  if (state.job) {
    showToast("StudyLens is still working on something. Stop it first, or wait a moment.");
    return false;
  }
  if (!(await ensureAIReady())) return false;

  const seq = state.sessionSeq;
  const job = { view, controller: new AbortController(), stage: null };
  state.job = job;
  if (options.prepare) options.prepare();
  setBusy();

  try {
    await work(makeAI(job.controller.signal));
    return true;
  } catch (err) {
    if (seq !== state.sessionSeq) return false; // the session changed underneath - nothing to restore
    if (options.onError) options.onError(err);
    if (err && err.code === "cancelled") showToast("Stopped.");
    else if (!options.silentErrors) handleError(err, "Something went wrong while generating this. Please try again.");
    return false;
  } finally {
    if (state.job === job) state.job = null;
    setBusy();
    if (seq === state.sessionSeq) {
      renderTools();
      renderResults();
      renderContentCard();
      persistSession();
    }
  }
}

function stopJob(userInitiated) {
  if (!state.job) return;
  state.job.controller.abort();
  if (!userInitiated) state.job = null;
}

function setBusy() {
  document.body.classList.toggle("is-busy", !!state.job);
  renderTools();
  renderWorking();
  updateFooter();
}

function setWorking(progress) {
  if (!state.job) return;
  let text = progress.text || WORKING_TEXT[state.job.view] || "Working…";
  let fraction = null;
  if (progress.stage === "reading") {
    text = "Reading part " + Math.min(progress.done + 1, progress.total) + " of " + progress.total + "…";
    fraction = progress.done / (progress.total + 1);
  } else if (progress.stage === "combining") {
    text = "Putting it all together…";
    fraction = progress.total / (progress.total + 1);
  }
  state.job.stage = { text, fraction };
  renderWorking();
}

function renderWorking() {
  if (!state.job) {
    hide(els.working);
    return;
  }
  const stage = state.job.stage || {};
  els.workingText.textContent = stage.text || WORKING_TEXT[state.job.view] || "Working…";
  const determinate = typeof stage.fraction === "number";
  els.workingMeter.classList.toggle("is-indeterminate", !determinate);
  els.workingFill.style.width = determinate ? Math.round(stage.fraction * 100) + "%" : "";
  show(els.working);
}

// ---- Study tools ---------------------------------------------------------------

function handleToolClick(tool) {
  if (!state.content) return;
  if (tool === "highlight") {
    if (state.highlight.total > 0) jumpToHighlight(Math.max(0, state.highlight.current));
    else handleHighlight();
    return;
  }
  if (tool === "ask") {
    openView("ask");
    els.askInput.focus();
    return;
  }
  if (hasView(tool) || (state.job && state.job.view === tool)) {
    openView(tool);
    return;
  }
  generate(tool);
}

function generate(view, options) {
  if (view === "quiz") return generateQuizJob(options || {});
  if (view === "flashcards") return generateFlashcardsJob(options || {});
  return generateTextJob(view);
}

const TEXT_GENERATORS = { summary: generateSummary, keyPoints: generateKeyPoints, reviewer: generateReviewer };

function generateTextJob(view) {
  const previous = state.results[view];
  const mode = state.settings.reviewerMode;

  return runJob(
    view,
    async (ai) => {
      const result = await TEXT_GENERATORS[view](ai, state.content.textContent, {
        count: state.settings.keyPointCount,
        mode,
        onProgress: setWorking,
        onToken: (fullText) => {
          state.results[view].text = fullText;
          scheduleStreamRender();
        }
      });
      state.results[view] = {
        text: result.text,
        chunkCount: result.chunkCount,
        mode: view === "reviewer" ? mode : undefined,
        createdAt: Date.now()
      };
      if (state.activeView !== view) showToast(VIEW_INFO[view].label + " is ready.", "success");
    },
    {
      prepare: () => {
        state.results[view] = { text: "", streaming: true, mode: view === "reviewer" ? mode : undefined };
        openView(view);
      },
      onError: (err) => {
        const partial = state.results[view];
        if (err && err.code === "cancelled" && partial && partial.text) {
          state.results[view] = { ...partial, streaming: false, stopped: true };
        } else if (previous) {
          state.results[view] = previous;
        } else {
          delete state.results[view];
        }
      }
    }
  );
}

function generateQuizJob(options) {
  const count = options.count || state.settings.quizQuestionCount;
  const difficulty = options.difficulty || state.settings.quizDifficulty;
  const previous = state.quiz;

  return runJob(
    "quiz",
    async (ai) => {
      const result = await generateQuiz(ai, state.content.textContent, { count, difficulty, onProgress: setWorking });
      state.quiz = StudyModes.createQuiz(result.questions, { count, difficulty });
      if (result.questions.length < count) {
        showToast("The AI wrote " + result.questions.length + " good questions from this material.", "info");
      }
    },
    {
      prepare: () => {
        if (options.count || options.difficulty) updateSettings({ quizQuestionCount: count, quizDifficulty: difficulty });
        state.quiz = null;
        openView("quiz");
      },
      onError: () => {
        state.quiz = previous;
      }
    }
  );
}

function generateFlashcardsJob(options) {
  const count = options.count || state.settings.flashcardCount;
  const previous = state.flashcards;

  return runJob(
    "flashcards",
    async (ai) => {
      const result = await generateFlashcards(ai, state.content.textContent, { count, onProgress: setWorking });
      state.flashcards = StudyModes.createDeck(result.cards, { count });
    },
    {
      prepare: () => {
        if (options.count) updateSettings({ flashcardCount: count });
        state.flashcards = null;
        openView("flashcards");
      },
      onError: () => {
        state.flashcards = previous;
      }
    }
  );
}

// ---- Ask ------------------------------------------------------------------------------

function sendQuestion(rawText) {
  const question = (rawText || "").trim();
  if (!question || !state.content) return;
  if (state.job) {
    showToast("Wait for the current answer to finish, or stop it first.");
    return;
  }

  const history = state.chat.slice();
  const reply = { role: "assistant", content: "", streaming: true };

  runJob(
    "ask",
    async (ai) => {
      const answer = await answerQuestion(ai, state.content.textContent, history, question, {
        onToken: (fullText) => {
          reply.content = fullText;
          scheduleStreamRender();
        }
      });
      reply.content = answer;
      reply.streaming = false;
    },
    {
      prepare: () => {
        state.chat.push({ role: "user", content: question }, reply);
        els.askInput.value = "";
        autosizeAskInput();
        openView("ask", { scroll: false });
        scrollChatToBottom(true);
      },
      onError: (err) => {
        reply.streaming = false;
        if (err && err.code === "cancelled") {
          if (reply.content) reply.stopped = true;
          else state.chat.splice(state.chat.indexOf(reply), 1);
        } else {
          reply.error = true;
          reply.content = friendlyMessage(err, "Something went wrong while answering. Please try again.");
        }
      },
      silentErrors: true
    }
  );
}

function autosizeAskInput() {
  els.askInput.style.height = "auto";
  els.askInput.style.height = Math.min(els.askInput.scrollHeight, 120) + "px";
}

function scrollChatToBottom(force) {
  const scroller = els.appScroll;
  const nearBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 160;
  if (force || nearBottom) requestAnimationFrame(() => (scroller.scrollTop = scroller.scrollHeight));
}

// ---- Right-click actions ("Explain with StudyLens", "Study selected text") ----------------

async function checkPendingAction() {
  let action = null;
  try {
    action = (await chrome.storage.session.get(STORAGE_KEYS.PENDING_ACTION))[STORAGE_KEYS.PENDING_ACTION];
  } catch (err) {
    return;
  }
  if (!action || action.at === state.lastActionAt) return;
  if (state.windowId !== null && action.windowId && action.windowId !== state.windowId) return; // another window's panel
  state.lastActionAt = action.at; // init and the storage listener can both see the same action
  await chrome.storage.session.remove(STORAGE_KEYS.PENDING_ACTION);
  if (Date.now() - action.at > 2 * 60 * 1000) return; // stale

  if (!els.onboardingOverlay.classList.contains("hidden")) {
    state.pendingAction = action;
    return;
  }
  runPendingAction(action);
}

async function runPendingAction(action) {
  const text = (action.text || "").trim();
  if (!text) {
    showToast("Select some text on the page first.");
    return;
  }
  if (state.job) {
    showToast("Wait for the current task to finish, or stop it first.");
    return;
  }

  const words = countWords(text);
  const selectionSource = {
    sourceType: "selection",
    title: action.title ? "Selection from “" + action.title + "”" : "Selected text",
    meta: hostnameOf(action.url),
    url: action.url,
    tabId: action.tabId,
    wordCount: words,
    textContent: text
  };

  if (action.type === "study") {
    if (words < 20) {
      showToast("Select a longer passage (a paragraph or more) to study it.");
      return;
    }
    if (!(await confirmReplaceSession())) return;
    startSession(selectionSource);
    showToast("Selection loaded - pick a study tool.", "success");
    return;
  }

  // "Explain": answer inside the current session when there is one, so the
  // explanation can use the surrounding material.
  if (!state.content) startSession(selectionSource);
  const quoted = text.length > 700 ? text.slice(0, 700) + "…" : text;
  sendQuestion("Explain this in simple terms, then give an example if the source supports it:\n\n“" + quoted.replace(/\s+/g, " ") + "”");
}

// ---- Highlighting (webpage source only) ---------------------------------------

async function handleHighlight() {
  const content = state.content;
  if (!content || content.sourceType !== "page") return;

  let tab;
  try {
    tab = await chrome.tabs.get(content.tabId);
  } catch (err) {
    showToast("The tab you scanned was closed. Open the page and scan it again to highlight it.", "error");
    return;
  }
  if (tab.url && !sameDocument(tab.url, content.url)) {
    showToast("That tab has moved to a different page. Scan it again to highlight it.", "error");
    return;
  }

  await runJob("highlight", async (ai) => {
    setWorking({ text: WORKING_TEXT.highlight });
    const { phrases } = await generateHighlightPhrases(ai, content.textContent, { count: HIGHLIGHT_COUNT });
    if (!phrases.length) throw new AIError("format", "The AI didn't return any passages to highlight. Please try again.");

    setWorking({ text: "Highlighting on the page…" });
    await ensureContentScript(content.tabId, content.url);
    const response = await chrome.tabs.sendMessage(content.tabId, { type: MESSAGE_TYPES.HIGHLIGHT_CONTENT, phrases });
    if (!response || !response.ok) throw new Error((response && response.error) || "Could not highlight this page.");

    applyHighlightStatus(response, content.tabId);
    if (!response.found) {
      showToast("Couldn't match the AI's passages to the page's text. Try again for a fresh set.", "error");
    } else {
      showToast("Highlighted " + response.found + " key passage" + (response.found === 1 ? "" : "s") + ".", "success");
      jumpToHighlight(0);
    }
  });
}

function applyHighlightStatus(status, tabId) {
  const current = state.highlight.current;
  state.highlight = {
    total: status.total || 0,
    items: status.items || [],
    current: status.total ? Math.min(Math.max(current, 0), status.total - 1) : -1,
    tabId: status.total ? tabId : null
  };
  renderHighlightPanel();
  renderTools();
}

async function refreshHighlightStatus() {
  const content = state.content;
  if (!content || content.sourceType !== "page" || !content.tabId) return;
  try {
    const status = await chrome.tabs.sendMessage(content.tabId, { type: MESSAGE_TYPES.HIGHLIGHT_STATUS });
    if (status && status.ok) applyHighlightStatus(status, content.tabId);
  } catch (err) {
    // No content script on that tab (yet) - nothing highlighted.
  }
}

async function jumpToHighlight(index) {
  const { tabId, total } = state.highlight;
  if (!tabId || !total) return;
  state.highlight.current = (index + total) % total;
  renderHighlightPanel();
  try {
    if (!state.tab || state.tab.id !== tabId) await chrome.tabs.update(tabId, { active: true });
    const response = await chrome.tabs.sendMessage(tabId, { type: MESSAGE_TYPES.SCROLL_TO_HIGHLIGHT, index: state.highlight.current });
    if (response && response.ok && !response.found) applyHighlightStatus(response, tabId);
  } catch (err) {
    clearHighlightState();
    showToast("The highlights are gone - the page may have reloaded. Highlight it again.", "error");
  }
}

function moveHighlight(direction) {
  if (state.highlight.total) jumpToHighlight(state.highlight.current + direction);
}

async function removeHighlights() {
  const tabId = state.highlight.tabId;
  clearHighlightState();
  if (!tabId) return;
  try {
    await chrome.tabs.sendMessage(tabId, { type: MESSAGE_TYPES.REMOVE_HIGHLIGHTS });
    showToast("Highlights removed.");
  } catch (err) {
    // The page already lost them (reload/navigation).
  }
}

function removeHighlightsQuietly() {
  const tabId = state.highlight.tabId;
  clearHighlightState();
  if (tabId) chrome.tabs.sendMessage(tabId, { type: MESSAGE_TYPES.REMOVE_HIGHLIGHTS }).catch(() => {});
}

function clearHighlightState() {
  state.highlight = { total: 0, current: -1, items: [], tabId: null };
  renderHighlightPanel();
  renderTools();
}

function renderHighlightPanel() {
  const { total, current, items } = state.highlight;
  if (!total || !state.content || state.content.sourceType !== "page") {
    hide(els.highlightPanel);
    return;
  }
  els.highlightPosition.textContent = current + 1 + " of " + total;
  els.highlightList.innerHTML = items
    .map(
      (text, i) =>
        '<li><button type="button" data-index="' + i + '"' + (i === current ? ' aria-current="true"' : "") + ">" +
        '<span class="hl-num">' + (i + 1) + "</span><span>" + Markdown.escapeHtml(text) + "</span></button></li>"
    )
    .join("");
  reveal(els.highlightPanel);
  const active = els.highlightList.querySelector('[aria-current="true"]');
  if (active) active.scrollIntoView({ block: "nearest" });
}

// ---- Prompts for other AI assistants (no AI call) ---------------------------------

function bestStudyMaterial() {
  const r = state.results;
  if (r.reviewer && r.reviewer.text) return r.reviewer.text;
  if (r.summary && r.summary.text) return r.summary.text;
  if (r.keyPoints && r.keyPoints.text) return r.keyPoints.text;
  return state.content ? state.content.textContent : "";
}

async function copyExternalPrompt(kind) {
  if (!state.content) return;
  const material = bestStudyMaterial();
  const prompt = kind === "quiz" ? buildQuizPrompt(material) : buildFlashcardPrompt(material);
  if (await copyText(prompt)) {
    showToast((kind === "quiz" ? "Quiz" : "Flashcard") + " prompt copied - paste it into ChatGPT, Gemini, or Claude.", "success");
  }
}

// ---- Results views -----------------------------------------------------------------

function hasView(view) {
  if (VIEW_INFO[view].kind === "text") return !!state.results[view];
  if (view === "quiz") return !!state.quiz;
  if (view === "flashcards") return !!state.flashcards;
  return state.chat.length > 0 || state.activeView === "ask";
}

function availableViews() {
  return VIEW_ORDER.filter((view) => hasView(view) || (state.job && state.job.view === view));
}

function openView(view, options) {
  state.activeView = view;
  renderResults();
  persistSession();
  if (!options || options.scroll !== false) {
    requestAnimationFrame(() => els.resultCard.scrollIntoView({ behavior: "smooth", block: "start" }));
  }
}

let lastTabsKey = "";
function renderResults() {
  const views = state.content ? availableViews() : [];
  if (!views.length) {
    state.activeView = null;
    hide(els.resultCard);
    lastTabsKey = "";
    updateFooter();
    return;
  }
  if (!views.includes(state.activeView)) state.activeView = views[0];

  // Rebuild the tab row only when it actually changes, so the pop-in
  // animation doesn't replay on every streamed word.
  const runningView = state.job ? state.job.view : "";
  const tabsKey = views.join(",") + "|" + state.activeView + "|" + runningView;
  if (tabsKey !== lastTabsKey) {
    lastTabsKey = tabsKey;
    els.resultTabs.innerHTML = views
      .map((view) => {
        const selected = view === state.activeView;
        const running = view === runningView;
        return (
          '<button type="button" class="rtab" role="tab" data-view="' + view + '" aria-selected="' + selected + '">' +
          (running ? '<span class="tab-spinner" aria-hidden="true"></span>' : iconSvg(VIEW_INFO[view].icon)) +
          "<span>" + VIEW_INFO[view].label + "</span></button>"
        );
      })
      .join("");
  }

  reveal(els.resultCard);
  renderActiveView();
  updateFooter();
}

function renderActiveView() {
  const view = state.activeView;
  const kind = VIEW_INFO[view].kind;
  els.viewText.classList.toggle("hidden", kind !== "text");
  els.viewQuiz.classList.toggle("hidden", kind !== "quiz");
  els.viewFlashcards.classList.toggle("hidden", kind !== "flashcards");
  els.viewAsk.classList.toggle("hidden", kind !== "ask");
  hide(els.resultNote);

  if (kind === "text") renderTextView(view);
  else if (kind === "quiz") renderQuizView();
  else if (kind === "flashcards") renderFlashcardsView();
  else renderAskView();
}

let streamFrame = 0;
function scheduleStreamRender() {
  if (streamFrame) return;
  streamFrame = requestAnimationFrame(() => {
    streamFrame = 0;
    if (state.activeView && !els.resultCard.classList.contains("hidden")) renderActiveView();
    if (state.activeView === "ask") scrollChatToBottom(false);
  });
}

const SKELETON_HTML = '<div class="skeleton" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>';

function renderTextView(view) {
  const result = state.results[view];
  if (!result) return;

  const notes = [];
  if (result.mode) notes.push(REVIEWER_MODE_LABEL[result.mode] + " reviewer");
  if (result.chunkCount > 1) notes.push("long source - read in " + result.chunkCount + " parts and combined");
  if (result.stopped) notes.push("stopped early - regenerate for the full version");
  if (notes.length && !result.streaming) {
    els.resultNote.textContent = notes.join(" · ");
    show(els.resultNote);
  }

  if (result.streaming && !result.text) {
    els.viewText.innerHTML = SKELETON_HTML;
    return;
  }

  els.viewText.innerHTML = Markdown.render(result.text, { headingIds: "sl-" + view });

  if (result.streaming) {
    // Put the blinking caret at the end of the last line of text.
    let target = els.viewText;
    while (target.lastElementChild && !/^(PRE|TABLE|HR|DIV|BR)$/.test(target.lastElementChild.tagName)) {
      target = target.lastElementChild;
    }
    const caret = document.createElement("span");
    caret.className = "caret";
    target.appendChild(caret);
    return;
  }

  // Long reviewers get a clickable table of contents.
  const sections = Array.from(els.viewText.querySelectorAll("h2[id]"));
  if (sections.length >= 3) {
    const toc = document.createElement("details");
    toc.className = "toc";
    toc.innerHTML =
      "<summary>Contents · " + sections.length + " sections</summary><ol>" +
      sections
        .map((h) => '<li><a href="#' + h.id + '" data-target="' + h.id + '">' + Markdown.escapeHtml(h.textContent) + "</a></li>")
        .join("") +
      "</ol>";
    els.viewText.prepend(toc);
  }
}

const quizActions = {
  container: () => els.viewQuiz,
  changed: () => persistSession(),
  replace: (quiz) => {
    state.quiz = quiz;
    persistSession();
    renderQuizView();
  },
  generate: (options) => generateQuizJob(options),
  settings: () => state.settings,
  toast: (message) => showToast(message)
};

function renderQuizView() {
  if (!state.quiz) {
    els.viewQuiz.innerHTML = SKELETON_HTML;
    return;
  }
  StudyModes.renderQuiz(els.viewQuiz, state.quiz, quizActions);
}

const flashcardActions = {
  container: () => els.viewFlashcards,
  changed: () => persistSession(),
  generate: (options) => generateFlashcardsJob(options),
  settings: () => state.settings,
  toast: (message) => showToast(message, "success")
};

function renderFlashcardsView() {
  if (!state.flashcards) {
    els.viewFlashcards.innerHTML = SKELETON_HTML;
    return;
  }
  StudyModes.renderFlashcards(els.viewFlashcards, state.flashcards, flashcardActions);
}

function renderAskView() {
  const container = els.viewAsk;
  if (!state.chat.length) {
    container.innerHTML =
      '<div class="chat-empty"><span class="chat-empty-icon">' + iconSvg("chat") + "</span>" +
      "<p>Ask anything about “" + Markdown.escapeHtml(state.content.title) + "”. Answers come from your source first.</p>" +
      '<div class="suggestions">' +
      ASK_SUGGESTIONS.map((s) => '<button type="button" class="suggestion">' + Markdown.escapeHtml(s) + "</button>").join("") +
      "</div></div>";
    container.querySelectorAll(".suggestion").forEach((btn) => btn.addEventListener("click", () => sendQuestion(btn.textContent)));
    return;
  }

  const html = state.chat.map((message, index) => {
    if (message.role === "user") {
      return '<div class="msg msg-user"><div class="bubble">' + Markdown.escapeHtml(message.content) + "</div></div>";
    }
    if (message.error) {
      return '<div class="msg msg-assistant msg-error"><div class="bubble">' + Markdown.escapeHtml(message.content) + "</div></div>";
    }
    if (message.streaming && !message.content) {
      return '<div class="msg msg-assistant"><div class="bubble"><span class="typing"><span></span><span></span><span></span></span></div></div>';
    }
    return (
      '<div class="msg msg-assistant"><div class="bubble md">' + Markdown.render(message.content) +
      (message.streaming ? '<span class="caret"></span>' : "") +
      (message.stopped ? '<p class="hint">Stopped early.</p>' : "") +
      "</div>" +
      (message.streaming
        ? ""
        : '<div class="msg-actions"><button type="button" class="btn btn-ghost btn-small" data-copy="' + index + '">' +
          iconSvg("copy") + "Copy</button></div>") +
      "</div>"
    );
  });

  const busy = !!state.job;
  container.innerHTML =
    '<div class="chat">' + html.join("") +
    (busy ? "" : '<button type="button" class="btn btn-ghost btn-small chat-clear">' + iconSvg("trash") + "Clear chat</button>") +
    "</div>";

  container.querySelectorAll("[data-copy]").forEach((btn) =>
    btn.addEventListener("click", async () => {
      if (await copyRich(state.chat[Number(btn.dataset.copy)].content)) showToast("Answer copied.", "success");
    })
  );
  const clear = container.querySelector(".chat-clear");
  if (clear) {
    clear.addEventListener("click", () => {
      state.chat = [];
      renderResults();
      renderTools();
      persistSession();
    });
  }
}

// ---- Footer actions ---------------------------------------------------------------

function updateFooter() {
  const view = state.activeView;
  if (!view || els.resultCard.classList.contains("hidden")) {
    hide(els.footer);
    els.toTopBtn.classList.add("no-footer");
    return;
  }
  show(els.footer);
  els.toTopBtn.classList.remove("no-footer");

  const isAsk = view === "ask";
  els.askForm.classList.toggle("hidden", !isAsk);
  els.footerActions.classList.toggle("hidden", isAsk);
  if (isAsk) {
    els.askSendBtn.disabled = !!state.job;
    return;
  }

  const running = !!state.job && state.job.view === view;
  const ready = hasViewData(view) && !running;
  const label = view === "flashcards" ? "Copy cards" : "Copy " + VIEW_INFO[view].label.toLowerCase();
  els.copyLabel.textContent = label;
  els.copyBtn.disabled = !ready;
  els.downloadBtn.disabled = !ready;
  els.deleteBtn.disabled = !ready;
  els.regenerateBtn.disabled = !!state.job;
  els.downloadBtn.title = view === "flashcards" ? "Download for Anki / Quizlet (.txt)" : "Download (.md)";
  els.downloadBtn.setAttribute("aria-label", els.downloadBtn.title);
}

function hasViewData(view) {
  if (VIEW_INFO[view].kind === "text") return !!(state.results[view] && state.results[view].text);
  if (view === "quiz") return !!state.quiz;
  if (view === "flashcards") return !!state.flashcards;
  return state.chat.length > 0;
}

function sourceLine() {
  const c = state.content;
  return "_Source: " + (c.url || c.title) + " · made with StudyLens on " + new Date().toLocaleDateString() + "_";
}

function activeExport() {
  const view = state.activeView;
  const title = state.content.title;
  if (VIEW_INFO[view].kind === "text") {
    return { text: state.results[view].text, rich: true, name: title + " - " + VIEW_INFO[view].label + ".md" };
  }
  if (view === "quiz") {
    return { text: StudyModes.quizToMarkdown(state.quiz, title), rich: true, name: title + " - Quiz.md" };
  }
  if (view === "flashcards") {
    return {
      text: StudyModes.deckToMarkdown(state.flashcards, title),
      rich: true,
      name: title + " - Flashcards (Anki-Quizlet).txt",
      download: StudyModes.deckToTSV(state.flashcards),
      type: "text/plain"
    };
  }
  return null;
}

async function copyActive() {
  const item = activeExport();
  if (!item) return;
  const ok = item.rich ? await copyRich(item.text) : await copyText(item.text);
  if (ok) {
    pulse(els.copyBtn);
    showToast("Copied - paste it into your notes, Docs, or Word.", "success");
  }
}

function downloadActive() {
  const item = activeExport();
  if (!item) return;
  if (item.download) {
    downloadFile(item.name, item.download, item.type);
    showToast("Saved as tab-separated text - import it into Anki or Quizlet.", "success");
  } else {
    downloadFile(item.name, item.text + "\n\n---\n" + sourceLine() + "\n");
  }
}

function regenerateActive() {
  const view = state.activeView;
  if (!view || state.job) return;
  generate(view);
}

async function deleteActive() {
  const view = state.activeView;
  if (!view || !hasViewData(view)) return;
  const answer = await confirmDialog({
    title: "Delete this " + VIEW_INFO[view].label.toLowerCase() + "?",
    body: "You can always generate it again.",
    confirmLabel: "Delete"
  });
  if (!answer.confirmed) return;
  if (VIEW_INFO[view].kind === "text") delete state.results[view];
  if (view === "quiz") state.quiz = null;
  if (view === "flashcards") state.flashcards = null;
  state.activeView = null;
  renderAll();
  persistSession();
}

function downloadStudyPack() {
  const c = state.content;
  const sections = ["# Study pack: " + c.title, sourceLine()];
  ["summary", "keyPoints", "reviewer"].forEach((view) => {
    const r = state.results[view];
    if (r && r.text) sections.push("---\n\n" + r.text);
  });
  if (state.flashcards) sections.push("---\n\n" + StudyModes.deckToMarkdown(state.flashcards, c.title));
  if (state.quiz) sections.push("---\n\n" + StudyModes.quizToMarkdown(state.quiz, c.title));
  const chat = state.chat.filter((m) => !m.error && m.content);
  if (chat.length) {
    sections.push(
      "---\n\n# Questions & Answers\n\n" +
        chat.map((m) => (m.role === "user" ? "**Q: " + m.content.replace(/\s+/g, " ") + "**" : m.content)).join("\n\n")
    );
  }
  downloadFile(c.title + " - Study pack.md", sections.join("\n\n") + "\n");
}

// ---- Clipboard & downloads -------------------------------------------------------

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch (err) {
    const area = document.createElement("textarea");
    area.value = text;
    area.style.position = "fixed";
    area.style.opacity = "0";
    document.body.appendChild(area);
    area.select();
    const ok = document.execCommand("copy");
    area.remove();
    if (!ok) showToast("Couldn't copy automatically - select the text and copy it manually.", "error");
    return ok;
  }
}

// Copies both Markdown (for AI chats and plain editors) and formatted HTML
// (so headings and bullets survive pasting into Google Docs or Word).
async function copyRich(markdown) {
  try {
    await navigator.clipboard.write([
      new ClipboardItem({
        "text/plain": new Blob([markdown], { type: "text/plain" }),
        "text/html": new Blob([Markdown.render(markdown)], { type: "text/html" })
      })
    ]);
    return true;
  } catch (err) {
    return copyText(markdown);
  }
}

function safeFileName(name) {
  return name.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 150) || "StudyLens";
}

function downloadFile(name, content, type) {
  const blob = new Blob([content], { type: (type || "text/markdown") + ";charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = safeFileName(name);
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 5000);
}

// ---- Small UI helpers ---------------------------------------------------------------

function show(node) {
  node.classList.remove("hidden");
}

function hide(node) {
  node.classList.add("hidden");
}

// Shows a hidden element with the entrance animation.
function reveal(node) {
  if (!node.classList.contains("hidden")) return;
  node.classList.remove("hidden");
  node.classList.remove("animate-in");
  void node.offsetWidth;
  node.classList.add("animate-in");
}

function pulse(node) {
  node.classList.remove("pop");
  void node.offsetWidth;
  node.classList.add("pop");
}

function iconSvg(name) {
  return '<svg class="icon" aria-hidden="true"><use href="#i-' + name + '"></use></svg>';
}

function hostnameOf(url) {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch (err) {
    return "";
  }
}

function countWords(text) {
  const trimmed = (text || "").trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function formatFileSize(bytes) {
  if (bytes < 1024 * 1024) return Math.max(1, Math.round(bytes / 1024)) + " KB";
  return (bytes / (1024 * 1024)).toFixed(1) + " MB";
}

function setPageStatus(text, variant) {
  const iconName = variant === "error" ? "alert" : variant === "success" ? "check" : "info";
  els.pageStatus.innerHTML = iconSvg(iconName) + "<span></span>";
  els.pageStatus.lastChild.textContent = text;
  els.pageStatus.className = "status" + (variant === "error" ? " status-error" : variant === "success" ? " status-success" : "");
}

function hidePageStatus() {
  els.pageStatus.className = "status hidden";
}

function showToast(message, type, options) {
  const kind = type || "info";
  const last = els.toastStack.lastElementChild;
  if (last && last.dataset.message === message) return; // don't stack duplicates

  const toast = document.createElement("div");
  toast.className = "toast toast-" + kind;
  toast.dataset.message = message;
  toast.innerHTML = iconSvg(kind === "error" ? "alert" : kind === "success" ? "check" : "info") + "<span></span>";
  toast.querySelector("span").textContent = message;

  const action = options && options.action;
  if (action) {
    const btn = document.createElement("button");
    btn.type = "button";
    btn.className = "toast-action";
    btn.textContent = action.label;
    btn.addEventListener("click", () => {
      action.onClick();
      dismiss();
    });
    toast.appendChild(btn);
  }

  els.toastStack.appendChild(toast);
  while (els.toastStack.children.length > 3) els.toastStack.firstElementChild.remove();

  function dismiss() {
    if (toast.classList.contains("is-leaving")) return;
    toast.classList.add("is-leaving");
    setTimeout(() => toast.remove(), 260);
  }
  setTimeout(dismiss, kind === "error" ? 6500 : action ? 6000 : 3200);
}

// Only ever show the student a plain-language message - never a raw
// JavaScript error.
function friendlyMessage(err, fallback) {
  if (err instanceof AIError || err instanceof FileParseError) return err.message;
  const message = (err && err.message) || "";
  const technical = /TypeError|undefined|null is not|Cannot read|ReferenceError|Receiving end does not exist|Could not establish connection|message port closed/i.test(message);
  return !message || technical ? fallback : message;
}

function handleError(err, fallback) {
  console.error("StudyLens:", err);
  const settingsCodes = ["auth", "no-key", "model", "quota", "config"];
  const action =
    err && settingsCodes.includes(err.code) ? { label: "Settings", onClick: () => chrome.runtime.openOptionsPage() } : null;
  showToast(friendlyMessage(err, fallback), "error", action ? { action } : null);
}

let dialogResolver = null;
function confirmDialog(options) {
  els.dialogTitle.textContent = options.title;
  els.dialogBody.textContent = options.body;
  els.dialogConfirm.textContent = options.confirmLabel || "Continue";
  els.dialogCancel.textContent = options.cancelLabel || "Cancel";
  els.dialogCheck.checked = false;
  els.dialogCheckRow.classList.toggle("hidden", !options.checkboxLabel);
  els.dialogCheckLabel.textContent = options.checkboxLabel || "";
  show(els.dialogOverlay);
  els.dialogConfirm.focus();
  if (dialogResolver) dialogResolver({ confirmed: false, checked: false });
  return new Promise((resolve) => {
    dialogResolver = resolve;
  });
}

function closeDialog(confirmed) {
  hide(els.dialogOverlay);
  const resolve = dialogResolver;
  dialogResolver = null;
  if (resolve) resolve({ confirmed, checked: els.dialogCheck.checked });
}
