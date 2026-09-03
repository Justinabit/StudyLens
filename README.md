# StudyLens

**See what matters. Learn what counts.**

StudyLens is an AI-powered study assistant for students, built as a Google
Chrome Extension. Give it a webpage **or your own PDF / Word / PowerPoint /
text file**, and it turns the material into a summary, key points, on-page
highlights, and a complete study reviewer — all of which you can copy and
paste into any AI assistant (ChatGPT, Gemini, Claude, Copilot, etc.) to
generate quizzes and flashcards.

StudyLens runs as a **side panel** (not a popup) so it can use the full
height of your browser window instead of a small, scroll-heavy box.

---

## Contents

- [Features](#features)
- [Technology](#technology)
- [Project Structure](#project-structure)
- [Installation (Chrome Setup)](#installation-chrome-setup)
- [AI Setup](#ai-setup)
- [Supported Files](#supported-files)
- [API Key Security](#api-key-security)
- [Privacy](#privacy)
- [How Highlighting Works](#how-highlighting-works)
- [Why a Side Panel](#why-a-side-panel)
- [Limitations](#limitations)
- [Troubleshooting](#troubleshooting)
- [Development](#development)
- [Future Improvements](#future-improvements)
- [Third-Party Libraries](#third-party-libraries)

---

## Features

- **Two sources, one workflow** — scan the current webpage, or upload a
  file. Both end up as the same kind of study material, so every feature
  below works identically either way (highlighting is the one exception,
  since it needs a live webpage to draw on).
- **Scan Current Page** — extracts the meaningful text of the page
  (articles, docs, Wikipedia, tutorials) while ignoring navigation, ads,
  cookie banners, sidebars, and other clutter.
- **Upload File** — reads a PDF, Word, PowerPoint, TXT, Markdown, CSV, or
  RTF file (see [Supported Files](#supported-files)), with drag-and-drop.
- **Content preview** — shows a short excerpt and word count before doing
  anything else, so you can confirm StudyLens found the right material.
- **Summary** — a short topic / overview / main ideas / conclusion summary.
- **Key Points** — a numbered list of the things you should remember.
- **Highlight Important Parts** (webpage only) — highlights the important
  passages directly on the page, with Previous/Next navigation and
  one-click removal.
- **Full Reviewer** — a structured study reviewer with three depths (Quick,
  Standard, Comprehensive). Comprehensive is the default: it prioritizes
  covering *every* topic in the source over keeping things short, organized
  into numbered sections with definitions, key terms, details, and examples.
- **Quiz Prompt / Flashcard Prompt** — ready-to-paste prompts (built
  locally, no extra AI call) that you can drop into any AI assistant to
  generate a quiz or flashcards from your reviewer.
- **Copy to clipboard** on every result, formatted as clean plain text.
- **Two AI providers** — OpenAI or Google Gemini, switchable anytime in
  Settings with no other change needed.
- Handles long documents by splitting them into sections before sending
  them to the AI, and combining the results back into one deduplicated
  answer — so a 40-page PDF doesn't just get you a reviewer of page one.
- **Full-height side panel** — a sticky header, a scrolling middle section,
  and a sticky "Copy" action at the bottom, so you're not endlessly
  scrolling back up to reach the buttons you need.

## Technology

- HTML, CSS, and vanilla JavaScript only — no React, Vue, Angular, or
  TypeScript.
- Chrome Extension **Manifest V3**, using the **Side Panel API**.
- Two AI providers implemented: **OpenAI** (`gpt-4o-mini` via the Chat
  Completions API) and **Google Gemini** (`gemini-3.1-flash-lite` via the
  Generative Language API). The AI integration is isolated in `aiService.js`
  so another provider can be added later without touching the UI code.
- Three small, vendored libraries handle file parsing entirely inside the
  browser — see [Third-Party Libraries](#third-party-libraries).

## Project Structure

```
studylens/
├── manifest.json          Extension configuration (Manifest V3, side panel)
├── constants.js            Shared message names, storage keys, defaults,
│                            file-upload settings (size limit, extensions)
├── background.js           Service worker: routes AI requests to aiService.js,
│                            opens the side panel when the toolbar icon is clicked
├── aiService.js             All AI provider logic + prompt templates
├── content.js               Injected into the page on demand: reads text,
│                            creates/removes/navigates highlights
├── highlight.css            Styles for on-page highlights (injected on demand)
├── sidepanel/
│   ├── sidepanel.html       Main StudyLens interface (full-height)
│   ├── sidepanel.css        Design tokens, sticky header/footer layout
│   ├── sidepanel.js         UI logic / state for both sources (page + file)
│   └── fileParser.js        Turns an uploaded File into clean text (PDF/DOCX/
│                            PPTX/TXT/MD/CSV/RTF) - see File Extraction vs AI
│                            Analysis below
├── options/
│   ├── options.html         Settings page
│   ├── options.css
│   └── options.js
├── vendor/                  Local, offline copies of the three parsing
│   ├── pdfjs/                libraries below - never fetched over the network
│   ├── mammoth/               at runtime (see Third-Party Libraries)
│   ├── jszip/
│   └── papaparse/
├── icons/
│   ├── icon16.png / icon48.png / icon128.png / logo_mark.png / logo_full.png
└── README.md
```

**How the pieces talk to each other:**

```
Side panel ──(chrome.tabs.sendMessage)──►  Content script (on the page)
  │            READ_PAGE, HIGHLIGHT_CONTENT, REMOVE_HIGHLIGHTS, SCROLL_TO_HIGHLIGHT
  │
  ├──(local, no messaging)──►  fileParser.js  (uploaded file → text, runs in the panel itself)
  │
  └──(chrome.runtime.sendMessage)──►  Background service worker  ──►  aiService.js  ──►  AI provider
               GENERATE_SUMMARY, GENERATE_KEY_POINTS, GENERATE_REVIEWER, GENERATE_HIGHLIGHT_PHRASES
```

Whether text came from a webpage or a file, it becomes the same shape in
`sidepanel.js` (`activeContent.textContent`), so `GENERATE_SUMMARY`,
`GENERATE_KEY_POINTS`, and `GENERATE_REVIEWER` don't know or care which
source it came from — that's the same background/AI code the extension has
always used, just fed from a second place.

The content script is **not** listed in the manifest as an always-on
script. It's injected only when you click "Scan Current Page," using the
minimal `activeTab` + `scripting` permissions — StudyLens has no access to
any page until you ask it to read one.

## Installation (Chrome Setup)

1. Download or clone the StudyLens folder.
2. Open Google Chrome.
3. Go to `chrome://extensions/`.
4. Turn on **Developer mode** (top-right toggle).
5. Click **Load unpacked**.
6. Select the `studylens` project folder.
7. Pin StudyLens to the toolbar (puzzle-piece icon → pin).
8. Click the StudyLens icon — this opens the **side panel** on the right
   side of the window (not a small popup).
9. Choose **Webpage** and click **Scan Current Page**, or choose **File**
   and upload a document.

## AI Setup

StudyLens needs an AI API key to generate summaries, key points,
highlights, and reviewers (the Quiz Prompt / Flashcard Prompt buttons do
**not** need a key — they just assemble text you already generated).

**Option A — OpenAI**
1. Get an API key from [platform.openai.com](https://platform.openai.com/).
2. Make sure billing/quota is set up on the account — a key with no quota
   will fail (see the error table below).

**Option B — Google Gemini (has a free tier)**
1. Get a free API key from
   [aistudio.google.com/apikey](https://aistudio.google.com/apikey).
2. Gemini's free tier has daily/per-minute limits, so heavy use may need to
   wait for the limit to reset or a paid tier.

Either way:

3. Click **⚙** in the StudyLens side panel header (or right-click the
   extension icon → Options).
4. Choose your **Provider**, paste in your key, and click **Save Settings**.

Anthropic is shown as a "coming soon" placeholder to make it clear how a
future provider would be added (see `aiService.js`).

### Understanding rate-limit / quota errors

Both OpenAI and Gemini return the same HTTP status (429) for two different
problems, so StudyLens reads the response to tell you which one actually
happened instead of showing one vague message for both:

| Message | What it means | What to do |
|---|---|---|
| "…has no available quota…" / "…run out of free quota…" | Your account has no credit or has hit its daily free limit. | Add billing (OpenAI) or wait for the daily reset / upgrade (Gemini), or switch providers in Settings. |
| "…rate-limited right now…" | You're sending requests faster than your plan allows per minute. | Wait a few seconds and try again. |
| "…rejected your API key…" | The key is missing, mistyped, or revoked. | Re-check the key on the Settings page. |

## Supported Files

| Format | Extension | How it's read |
|---|---|---|
| PDF | `.pdf` | Text extracted page by page with [pdf.js](https://mozilla.github.io/pdf.js/). Scanned/image-only PDFs are detected and reported rather than silently producing an empty reviewer (no OCR in this version). Password-protected PDFs are also detected and reported. |
| Word | `.docx` | Converted to HTML with [Mammoth](https://github.com/mwilliamson/mammoth.js), then walked the same way `content.js` walks a webpage - headings, paragraphs, lists, and tables come out structured, not as one wall of text. |
| PowerPoint | `.pptx` | Read as a zip of slide XML (via [JSZip](https://stuk.github.io/jszip/)) — each slide's text and speaker notes are extracted and clearly labeled `SLIDE 1`, `SLIDE 2`, etc., so the reviewer understands the presentation's structure. |
| Plain text | `.txt` | Read directly. |
| Markdown | `.md` | Read directly, with heading/list/bold/link syntax lightly stripped so the AI sees clean prose instead of `##`/`**`/`[]()` symbols. |
| CSV | `.csv` | Parsed with [PapaParse](https://www.papaparse.com/) and turned into `Column: value` lines per row (capped at 500 rows so a huge spreadsheet doesn't overwhelm the reviewer). |
| RTF | `.rtf` | A small best-effort control-word stripper (no vendored RTF library) - formatting-heavy RTF files may not extract perfectly; StudyLens says so when this path is used. |

**Limits:** 25 MB per file. Unsupported formats and oversized files are
rejected immediately with a plain-language message — StudyLens never
silently fails or produces an empty reviewer.

## API Key Security

- The key is **never hard-coded** anywhere in the source.
- It is stored only in `chrome.storage.local`, on your own device.
- It is sent **directly from your browser to the AI provider** you chose
  (OpenAI or Google) — never to any StudyLens/Anthropic server, because
  there isn't one.
- **This is a local prototype, not a production security model.** A key
  stored inside a browser extension is readable by anyone with access to
  that browser profile. For a real product used by other people, the AI
  request should go through your own backend server that holds the key,
  instead of the extension calling the AI provider directly.
- Never commit a filled-in API key to a public repository.

## Privacy

StudyLens only touches a webpage when you explicitly click "Scan Current
Page," and only reads a file when you choose to upload one. It does
**not**:

- Continuously monitor webpages or run in the background
- Track or store your browsing history
- Read other open tabs
- Access your camera, microphone, or location
- Collect cookies or passwords

**Uploaded files never leave your computer as files.** PDF/DOCX/PPTX/CSV
parsing happens entirely inside the side panel using the vendored libraries
in `/vendor` — nothing is uploaded to a server to be parsed. Only the
**extracted text** (from a webpage or a file) is sent anywhere, and only to
the AI provider you configured, and only when you click a study feature
(Summary, Key Points, Full Reviewer, Highlight).

The only things saved to `chrome.storage.local` are your **settings**
(provider, API key, reviewer mode, key point count, confirmation
preference) and a flag noting you've seen the onboarding message. Extracted
text, results, and highlights live only in the side panel while it's open
and are discarded when it closes. Use **Settings → Clear all StudyLens data
on this device** at any time to remove everything StudyLens has stored.

Before the first AI-powered action, StudyLens shows a plain-language notice
that the extracted text will be sent to your chosen AI provider, with a
Continue/Cancel choice. You can turn this notice off in Settings once you
understand it.

## How Highlighting Works

Highlighting only applies to a scanned webpage (a file has no live page to
draw on). StudyLens asks the AI to return a handful of **exact quotes**
from the page (not paraphrases). The content script then searches the
page's actual text nodes for each quote and wraps the match in a `<mark>`
element — it never rewrites the page's HTML wholesale. "Remove Highlights"
unwraps those `<mark>` elements and merges the text back together,
restoring the page to its original state. Links, images, and existing
formatting are left alone.

**Limitation:** a quote that is split across multiple inline elements in
the original HTML (for example, part of it inside a `<b>` tag) may not
match. This trade-off keeps the highlighting code simple and safe rather
than rewriting arbitrary page structure.

## Why a Side Panel

Chrome popups are capped at a small fixed size, which meant the original
StudyLens popup needed constant scrolling once file upload, source
switching, and a full reviewer were added. Chrome's Side Panel API gives
StudyLens the full height of the browser window instead, with a layout of:

- a **sticky header** (logo + Settings, always visible)
- a **scrolling middle section** (source, preview, study tools, results)
- a **sticky footer** with the primary **Copy** action, so it's always
  reachable without scrolling back up

The side panel also stays open while you browse, switch tabs, and read —
unlike a popup, which closes the moment it loses focus.

## Limitations

- **No OCR.** Scanned/image-only PDFs are detected and reported, not
  processed — StudyLens tells you rather than producing an empty reviewer.
- **PPTX slide order** is inferred from the slide files' internal numbering
  in the `.pptx` zip, which is almost always the real presentation order
  but in rare cases (slides manually reordered in a way that didn't rename
  the underlying files) could differ from what you see when presenting.
- **RTF** uses a small best-effort text stripper, not a full RTF parser -
  heavily-formatted RTF files may lose some content. Prefer DOCX or PDF
  when you have the choice.
- **CSV** is capped at 500 data rows to keep a reviewer generated from a
  huge spreadsheet readable; StudyLens tells you when it truncates.
- **Switching tabs while the panel is open:** StudyLens deliberately
  requests only the minimal `activeTab` permission (not full `tabs`
  access), which Chrome grants for whatever tab was active when you *click
  the StudyLens toolbar icon*. Because the side panel stays open across tab
  switches, if you switch to a different tab without re-clicking the
  toolbar icon, "Scan Current Page" may show *"StudyLens needs permission
  to read this tab."* Clicking the toolbar icon again fixes this instantly
  — it's the trade-off for not requesting a broader permission just to
  read tab titles/URLs it doesn't otherwise need.
- File parsing runs entirely in the side panel's own document (not a
  background worker), so extraction pauses if you close the panel
  mid-extraction — reopen it and try again.

## Troubleshooting

| Problem | What's happening | Try this |
|---|---|---|
| "This page cannot be read by StudyLens." | You're on a `chrome://`, extension, or Chrome Web Store page. | Open a normal webpage, or switch to the File source instead. |
| "StudyLens needs permission to read this tab." / "…lost permission to read this tab." | The panel is looking at a different tab than the one that opened it (see Limitations). | Click the StudyLens icon in the toolbar, then try again. |
| "Not enough readable content was found on this page." | The page has very little text StudyLens could find. | Open the main article, not a listing/homepage. |
| "Unsupported file type" | The file isn't PDF/DOCX/PPTX/TXT/MD/CSV/RTF. | Convert or export it to a supported format. |
| "File is too large." | The file is over 25 MB. | Split it, or upload a smaller version. |
| "This PDF appears to contain scanned images…" | The PDF has no selectable text (it's images of pages). | Use a text-based PDF, or run OCR yourself first with another tool. |
| "This file appears to be password-protected…" | The PDF/document is locked. | Remove the password and re-upload. |
| "Add an AI API key in Settings…" | No key saved yet. | Add one in Settings (see AI Setup above). |
| "…rejected your API key." | The key is invalid, expired, or has no quota. | Check the key at platform.openai.com or aistudio.google.com/apikey. |
| "…has no available quota…" | Billing/free-tier limit reached, not a temporary rate limit. | See "Understanding rate-limit / quota errors" above. |
| Highlights don't appear | The AI's quotes didn't match the page text exactly. | Try again — regenerate uses a fresh set of quotes. |

If you ever see a raw technical error in the console, please note it and
open an issue — study features should always fail with a plain-language
message, never a stack trace, inside the panel itself.

## Development

- All AI logic lives in `aiService.js`. To add a provider, implement a new
  entry in the `PROVIDERS` object with the same `(apiKey, messages) =>
  string` shape, then add it to the Settings provider dropdown.
- All file-parsing logic lives in `sidepanel/fileParser.js`, kept
  deliberately separate from both the AI logic and the UI (see
  `constants.js` → `FILE_SUPPORT` for the extension list and size limit):
  **file parser** extracts text → **aiService** understands/organizes it →
  **sidepanel.js** displays it. To support a new file type, add a `parseX`
  function there and one line in `extractFileContent`'s dispatcher.
- Message names live in `constants.js` so side panel/background/content
  code stays in sync.
- The content script re-declares a small local copy of the message names
  instead of importing `constants.js`, since content scripts run in an
  isolated world and this keeps `content.js` a single, self-contained file
  that's easy to read top to bottom.
- No build step — reload the unpacked extension from `chrome://extensions/`
  after editing files.

## Future Improvements

StudyLens is intentionally scoped small for this prototype. The project is
structured so these could be added later without a rewrite:

- OCR for scanned PDFs
- Saved reviewers and study history
- Direct in-panel quiz/flashcard generation (beyond the copy-paste prompts)
- Additional AI providers (Anthropic)
- Custom prompt templates
- YouTube transcript support
- Notes, export to TXT/Markdown/PDF
- Dark mode
- Cloud sync across devices
- A "Cancel" control for long file-extraction/AI operations (today, closing
  and reopening the panel is the way to stop an in-progress request)

## Third-Party Libraries

Vendored locally under `/vendor` (no CDN, no remote code fetched at
runtime — required for Manifest V3 and better for privacy/reliability).
Each folder includes that project's original license file.

| Library | Version | Used for | License |
|---|---|---|---|
| [pdf.js](https://mozilla.github.io/pdf.js/) | 6.3.289 | PDF text extraction | Apache-2.0 |
| [Mammoth](https://github.com/mwilliamson/mammoth.js) | 1.12.2 | DOCX → HTML conversion | BSD-2-Clause |
| [JSZip](https://stuk.github.io/jszip/) | 3.10.1 | Reading `.pptx` files as zip archives | MIT / GPLv3 (dual) |
| [PapaParse](https://www.papaparse.com/) | 5.7.0 | CSV parsing | MIT |
