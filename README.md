# StudyLens

**See what matters. Learn what counts.**

StudyLens is an AI study assistant for students, built as a Google Chrome
extension. Give it a webpage, **your own PDF / Word / PowerPoint / text
file**, or just some selected text, and it turns the material into a
summary, key points, a full reviewer, an interactive quiz, flip-card
flashcards, on-page highlights, and a tutor you can ask follow-up questions.

StudyLens runs in Chrome's **side panel**, so it stays open next to what
you're reading while you browse.

---

## Contents

- [What's New in 2.0](#whats-new-in-20)
- [Features](#features)
- [Installation](#installation)
- [AI Setup](#ai-setup)
- [Supported Files](#supported-files)
- [Keyboard Shortcuts](#keyboard-shortcuts)
- [Permissions](#permissions)
- [API Key Security](#api-key-security)
- [Privacy](#privacy)
- [How Highlighting Works](#how-highlighting-works)
- [Long Documents](#long-documents)
- [Project Structure](#project-structure)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Changelog](#changelog)
- [Third-Party Libraries](#third-party-libraries)

---

## What's New in 2.0

- **Interactive quizzes** - multiple choice with instant feedback,
  explanations, a score screen, "retry missed", and a full answer review.
- **Flashcards** - 3D flip cards with *Got it* / *Still learning*, shuffle,
  a "still learning only" pass, and **export to Anki or Quizlet**.
- **Ask** - chat with your material. Answers come from the source first,
  and anything from general knowledge is clearly labeled.
- **Right-click actions** - select text on any page and choose
  **Explain with StudyLens** or **Study selected text with StudyLens**.
- **Streaming results** - summaries and reviewers appear as they're
  written, with real progress for long documents and a **Stop** button.
- **Anthropic Claude** support alongside Google Gemini and OpenAI, with a
  separate saved key for each provider and a **Test connection** button.
- **Read PDFs open in Chrome** - on a PDF tab, "Read this PDF" downloads and
  reads it directly.
- **Your session survives closing the panel** (memory-only - see
  [Privacy](#privacy)).
- **Output language** - results in the source's language, or always in
  English, Filipino, Spanish, and more.
- **New interface** - dark mode, text size options, animations, rendered
  formatting (headings, bold, lists, tables), a clickable table of
  contents for reviewers, and rich copy that keeps formatting when pasted
  into Google Docs or Word.
- **Many bug fixes** - see the [Changelog](#changelog).

## Features

- **Three sources, one workflow** - scan the current webpage, upload a
  file, or right-click selected text. Every study tool works the same way
  for all three (highlighting needs a live webpage).
- **Scan this page** - extracts the meaningful text of the page (articles,
  docs, Wikipedia, tutorials) while ignoring navigation, ads, cookie
  banners, sidebars, share buttons, and citation markers like `[1]`.
- **Upload a file** - drag and drop anywhere on the panel, or browse.
- **Summary** - topic, overview, main ideas, and conclusion.
- **Key Points** - a numbered list of what to remember (3-15, set in
  Settings).
- **Reviewer** - a structured study guide in three depths (Quick,
  Standard, Comprehensive). Comprehensive covers *every* topic with
  definitions, key terms, details, and examples.
- **Quiz** - 5-20 questions, Easy / Mixed / Hard. Answer options are
  shuffled so the right answer isn't always in the same spot.
- **Flashcards** - 10-30 cards per set.
- **Ask** - suggested questions to get started ("What are the most likely
  exam questions?") and a running conversation.
- **Highlight on page** (webpages) - marks the key passages on the page
  itself, with a clickable list, Previous/Next, and one-click removal.
- **Copy, download, or export everything** - copy any result (formatted),
  download it as Markdown, download flashcards for Anki/Quizlet, or
  download a whole **study pack** with every result in one file.
- **Prompts for other assistants** - copy a ready-made quiz or flashcard
  prompt to paste into ChatGPT, Gemini, or Claude.

## Installation

1. Download this repository (Code → Download ZIP) and unzip it, or clone it.
2. Open Google Chrome (version 116 or newer) and go to `chrome://extensions/`.
3. Turn on **Developer mode** (top-right toggle).
4. Click **Load unpacked** and select the StudyLens folder (the one that
   contains `manifest.json`).
5. Pin StudyLens to the toolbar (puzzle-piece icon → pin).
6. Click the StudyLens icon (or press **Alt+Shift+S**) to open the side panel.

To update after pulling new code, click the reload icon on the StudyLens
card in `chrome://extensions/`.

## AI Setup

StudyLens uses your own API key. Click the **settings** icon in the panel
header (or right-click the extension icon → Options), choose a provider,
paste your key, and click **Test connection**. Changes save automatically.

| Provider | Get a key | Default model | Notes |
|---|---|---|---|
| **Google Gemini** | [aistudio.google.com/apikey](https://aistudio.google.com/apikey) | `gemini-3.1-flash-lite` | Has a free tier (per-minute and daily limits). Easiest way to start. |
| **OpenAI** | [platform.openai.com/api-keys](https://platform.openai.com/api-keys) | `gpt-4o-mini` | Needs billing set up on your account. |
| **Anthropic Claude** | [console.anthropic.com/settings/keys](https://console.anthropic.com/settings/keys) | `claude-opus-5-5` | Needs credits on your account. |

Each provider keeps its own key, so you can switch between them without
re-entering anything. The optional **Model** field lets you use a
different model, or recover if a provider retires the default model name.

The "Copy quiz/flashcard prompt" buttons don't need a key - they just
assemble text for you to paste into another assistant.

### Understanding rate-limit and quota errors

Providers use the same HTTP error (429) for two different problems, so
StudyLens reads the response to tell you which one happened:

| Message | What it means | What to do |
|---|---|---|
| "…free tier allows a limited number of requests per minute…" / "…rate-limiting…" | Too many requests too quickly. StudyLens retries short waits automatically. | Wait a moment and try again. |
| "…used today's free Gemini quota…" / "…no available quota…" / "…enough credits…" | Your account's daily limit or balance is used up. | Wait for the reset, add billing/credits, or switch providers. |
| "…rejected your API key…" | The key is missing, mistyped, or revoked. | Re-check it in Settings and use **Test connection**. |

## Supported Files

| Format | Extension | How it's read |
|---|---|---|
| PDF | `.pdf` | Text extracted page by page with [pdf.js](https://mozilla.github.io/pdf.js/), keeping line breaks. Scanned (image-only) and password-protected PDFs are detected and explained. |
| Word | `.docx` | Converted with [Mammoth](https://github.com/mwilliamson/mammoth.js); titles, headings, nested lists, and tables keep their structure. |
| PowerPoint | `.pptx` | Read with [JSZip](https://stuk.github.io/jszip/). Slides come out in their **real presentation order**, with titles and each slide's own speaker notes. |
| Plain text | `.txt` | Read directly. |
| Markdown | `.md` | Headings and lists are kept; links, images, front matter, and HTML are cleaned up. |
| CSV | `.csv` | Parsed with [PapaParse](https://www.papaparse.com/) into `Column: value` lines (first 500 rows). |
| RTF | `.rtf` | A built-in best-effort reader that skips font/color tables and decodes accented characters. |
| HTML | `.html`, `.htm` | Saved web pages, read like a scanned page. |

**Limit:** 25 MB per file. Files are read entirely inside your browser.

## Keyboard Shortcuts

| Where | Keys |
|---|---|
| Anywhere | **Alt+Shift+S** opens StudyLens (change it at `chrome://extensions/shortcuts`) |
| Any page | Select text → right-click → **Explain with StudyLens** / **Study selected text with StudyLens** |
| Quiz | **A-D** (or **1-4**) to answer, **Enter** for next, **←** to go back |
| Flashcards | **Space** flip, **← →** move, **1** still learning, **2** got it |
| Ask | **Enter** to send, **Shift+Enter** for a new line |

## Permissions

| Permission | Why |
|---|---|
| `activeTab`, `scripting` | Read the page you're on - only when you click **Scan** - and draw highlights on it. |
| `sidePanel` | Show StudyLens in Chrome's side panel. |
| `storage` | Save your settings, and keep your current session in memory. |
| `contextMenus` | The right-click "Explain / Study selected text" items. |
| Host access to `api.openai.com`, `generativelanguage.googleapis.com`, `api.anthropic.com` | Send your request to the AI provider you chose. |
| **Optional:** access to all sites | Only if you click **Let StudyLens read any tab I scan**. Without it, Chrome only lets StudyLens read a tab after you click the toolbar icon on that tab. Even with it, StudyLens never reads a page until you click Scan. |

## API Key Security

- Keys are **never hard-coded**. They're stored only in
  `chrome.storage.local` on your device.
- Requests go **directly from your browser to the provider** you chose -
  there is no StudyLens server.
- A key stored in a browser extension can be read by anyone with access to
  that browser profile. Use a key with a sensible spending limit, and don't
  leave one on a shared computer.
- For a product used by other people, AI requests should go through your
  own backend that holds the key.
- Never commit a filled-in API key to a public repository.

## Privacy

StudyLens only reads a webpage when you click **Scan this page**, only
reads a file when you choose one, and only reads selected text when you
use the right-click menu. It does **not** monitor pages, track your
browsing history, read other tabs, or use your camera, microphone, or
location.

- **Files never leave your computer as files.** Parsing happens inside the
  side panel using the libraries in `/vendor`.
- **Only extracted text is sent**, only to your chosen AI provider, and only
  when you use a study tool. By default StudyLens asks before the first
  request in each panel session (you can turn this off in Settings).
- **Your current session** (source text and results) is kept in
  `chrome.storage.session`, which Chrome holds **in memory only**. It
  survives closing and reopening the panel, and is erased when you close the
  browser. It is never written to disk.
- **Settings** (provider, keys, preferences) are saved in
  `chrome.storage.local`.
- **Settings → Clear all StudyLens data on this device** removes everything.

## How Highlighting Works

StudyLens asks the AI for a handful of **exact quotes** from the page. The
content script flattens the page's visible text into one normalized string
(ignoring differences in spacing, curly quotes, and dashes, and skipping
citation markers like `[1]`) while remembering which text node each
character came from. That lets a quote match even when it runs through
links, bold words, or other inline formatting. Each match is wrapped in one
`<mark>` per text node it touches.

The page's HTML is never rewritten wholesale. **Remove** unwraps the marks
and restores the original text nodes exactly. If the AI changes a word near
the end of a long quote, StudyLens falls back to matching the start of it.

## Long Documents

Text up to ~48,000 characters (roughly 25-30 pages) is handled in a single
request. Longer sources are read in parts - two at a time, with progress
shown - and the notes from each part are combined into one result, so a
long PDF gets a reviewer of the whole thing, not just page one. Quizzes and
flashcards spread their questions across all parts. **Ask** picks the most
relevant passages for each question.

## Project Structure

```
studylens/
├── manifest.json          Manifest V3 configuration
├── constants.js           Shared names, provider info, default settings, limits
├── background.js          Service worker: install/upgrade, toolbar → side panel,
│                          right-click menu
├── aiService.js           All AI logic: providers (Gemini/OpenAI/Claude),
│                          streaming, retries, chunking, prompts
├── content.js             Injected on demand: reads the page, highlights passages
├── highlight.css          On-page highlight styles (injected on demand)
├── sidepanel/
│   ├── sidepanel.html     Panel layout and icon set
│   ├── sidepanel.css      Design tokens (light/dark), layout, animations
│   ├── sidepanel.js       Panel state, sources, jobs, views, export
│   ├── studyModes.js      Interactive quiz and flashcards
│   ├── markdown.js        Safe Markdown renderer for AI output
│   └── fileParser.js      File → text (PDF/DOCX/PPTX/TXT/MD/CSV/RTF/HTML)
├── options/               Settings page
├── vendor/                pdf.js, Mammoth, JSZip, PapaParse (local copies)
└── icons/
```

**How the pieces talk to each other:**

```
Side panel ──(chrome.tabs.sendMessage)──► content.js on the page
  │          READ_PAGE, HIGHLIGHT_CONTENT, SCROLL_TO_HIGHLIGHT, REMOVE_HIGHLIGHTS, HIGHLIGHT_STATUS
  │
  ├── fileParser.js   (file → text, inside the panel)
  ├── aiService.js    (panel → AI provider, streamed)
  │
Background ──(chrome.storage.session)──► Side panel
             right-click "Explain" / "Study selected text"
```

**Why AI requests run in the side panel, not the background worker:**
Chrome stops an extension's service worker when a single network response
takes more than 30 seconds, which a comprehensive reviewer of a long
document can easily do. In 1.x this surfaced as random "message port
closed" failures. Running requests in the panel avoids that, and makes
streaming and the Stop button possible.

## Limitations

- **No OCR.** Scanned/image-only PDFs are detected and explained, not read.
- **Google Docs** draws its text in a way extensions can't read. Use File →
  Download (.docx/.pdf) and upload it - StudyLens shows this hint on Docs pages.
- **Chrome pages** (`chrome://`, the Web Store, other extensions) can't be
  read by any extension.
- **Local files opened in Chrome** (`file://`) need "Allow access to file
  URLs" turned on for StudyLens in `chrome://extensions`, or you can upload
  the file instead.
- **RTF** support is best-effort; DOCX or PDF is more reliable.
- **CSV** is capped at 500 rows.
- **Highlights** disappear if the page reloads or navigates (StudyLens
  notices and resets the navigator).

## Troubleshooting

| Problem | Try this |
|---|---|
| "StudyLens doesn't have permission to read this tab" | Click the StudyLens toolbar icon while on that tab, then scan again - or click **Let StudyLens read any tab I scan**. |
| "Only N words of readable text were found" | Open the main article (not a homepage or listing), or use the File tab. |
| "Chrome doesn't let extensions read this kind of page" | It's a Chrome-internal page. Open a normal webpage or upload a file. |
| A PDF tab won't read | Allow access to all sites, or save the PDF and upload it. |
| "This PDF looks like scanned images" | Use a text-based PDF, or run OCR in another tool first. |
| "…rejected your API key" | Re-check the key in Settings and click **Test connection**. |
| Model not found | Clear the **Model** field to use the default, or enter a current model name. |
| Highlights don't appear | Click **Highlight on page** again for a fresh set of passages. |
| The panel says it's still working | Click **Stop** on the progress bar. |

## Development

- No build step: edit files, then reload the extension in `chrome://extensions/`.
- **Add an AI provider:** add an entry to `AI_PROVIDER_INFO` in
  `constants.js` and a function to `PROVIDERS` in `aiService.js` that
  streams text and calls `opts.onToken(fullText)`. The Settings page picks
  it up automatically.
- **Add a file type:** add a `parseX` function in `sidepanel/fileParser.js`
  and one branch in `extractFileContent`, plus the extension in
  `FILE_SUPPORT` (`constants.js`).
- `content.js` keeps its own copy of the message names, since content
  scripts run in an isolated world and this keeps the file self-contained.
- AI output is always rendered through `sidepanel/markdown.js`, which
  escapes HTML first - never insert model output with `innerHTML` directly.

## Changelog

### 2.0.0

New: interactive quiz, flashcards (with Anki/Quizlet export), Ask chat,
right-click Explain / Study selected text, streaming results with Stop,
Anthropic Claude provider, per-provider keys, Test connection, model
override, output language, reading PDFs open in a tab, session restore,
dark mode, text size, study pack export, rich copy, keyboard shortcuts, and
a redesigned, animated interface.

Fixed:

- Long AI requests failed with "message port closed" because Chrome stopped
  the background service worker after 30 seconds. Requests now run in the
  side panel.
- Adding an API key in Settings didn't reach an already-open panel until it
  was reopened - and changing the reviewer depth in the panel could
  **overwrite the newly saved key** with the old, empty one.
- Settings page: after "Clear all data," every button got a second click
  handler, so **Show/Hide** stopped working and saves ran twice.
- Highlighting almost never worked on real pages: quotes that crossed a link
  or bold word couldn't match, and a word like "menu" or "header" anywhere
  in the page's `<body>` classes (common on Wikipedia and many blogs) blocked
  highlighting for the entire page.
- Page reading dropped text placed directly inside `<div>`s, and treated
  elements such as "canvas" or "has-sidebar" as navigation junk.
- After the extension was reloaded, scanning a previously scanned page
  failed until the page was refreshed.
- Every PDF failed after extraction in the bundled pdf.js version, and the
  raw error was shown to the student.
- PowerPoint slides came out in file order instead of presentation order,
  and speaker notes could be attached to the wrong slide.
- Nested lists lost their structure, RTF files leaked font names into the
  text, and Word's Title style was treated as body text.
- Long toast messages ran off the edge of the panel, and dropping a file
  outside the drop area navigated the panel away.
- Switching browser tabs erased all generated results; they're now kept
  until you start a new session.
- Tab tracking reacted to tabs in other browser windows.

### 1.0.0

Initial release.

## Third-Party Libraries

Vendored locally under `/vendor` (no CDN, no remote code at runtime -
required for Manifest V3). Each folder includes the project's license.

| Library | Version | Used for | License |
|---|---|---|---|
| [pdf.js](https://mozilla.github.io/pdf.js/) | 6.3.289 | PDF text extraction | Apache-2.0 |
| [Mammoth](https://github.com/mwilliamson/mammoth.js) | 1.12.2 | DOCX → HTML conversion | BSD-2-Clause |
| [JSZip](https://stuk.github.io/jszip/) | 3.10.1 | Reading `.pptx` files | MIT / GPLv3 (dual) |
| [PapaParse](https://www.papaparse.com/) | 5.7.0 | CSV parsing | MIT |
