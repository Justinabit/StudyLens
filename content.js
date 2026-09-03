/*
  content.js
  ----------
  Runs inside the current webpage, but ONLY after the student clicks
  "Read This Page" (StudyLens uses chrome.scripting to inject this file on
  demand - it is never present on a page the student didn't ask about).

  Responsibilities:
    1. Extract meaningful, study-worthy text from the page.
    2. Highlight important passages the student asked to see.
    3. Remove those highlights again, restoring the original page.
    4. Scroll to a specific highlight for review.

  This file intentionally avoids frameworks and keeps the DOM changes small
  and reversible (see README > How Highlighting Works).
*/

// Guard against the file being injected more than once into the same page.
if (!window.__studylensInjected) {
  window.__studylensInjected = true;

  (function () {
    "use strict";

    // Local copy of the message names StudyLens uses (kept in sync with
    // constants.js by hand, since content scripts run in an isolated world
    // and we want this file to stay a single, simple, self-contained unit).
    const MSG = {
      PING: "PING",
      READ_PAGE: "READ_PAGE",
      HIGHLIGHT_CONTENT: "HIGHLIGHT_CONTENT",
      REMOVE_HIGHLIGHTS: "REMOVE_HIGHLIGHTS",
      SCROLL_TO_HIGHLIGHT: "SCROLL_TO_HIGHLIGHT"
    };

    const HIGHLIGHT_CLASS = "studylens-highlight";
    const HIGHLIGHT_FOCUS_CLASS = "studylens-highlight-focus";
    const MIN_PHRASE_LENGTH = 8;

    // Elements/tags we never want to treat as study content.
    const JUNK_TAGS = new Set([
      "NAV", "HEADER", "FOOTER", "ASIDE", "SCRIPT", "STYLE", "NOSCRIPT",
      "IFRAME", "FORM", "BUTTON", "SVG", "VIDEO", "AUDIO"
    ]);
    const JUNK_PATTERN = /nav|menu|sidebar|footer|header|advert|banner|cookie|consent|popup|modal|social|share|comment|related|recommend|subscribe|newsletter|signin|login|breadcrumb|pagination|masthead|promo/i;

    // Kept between messages so Highlight/Remove/Scroll act on the same
    // container that was actually read.
    let mainContainerEl = null;
    let highlightElements = [];

    /* ---------------------------------------------------------------- *
     *  1. CONTENT EXTRACTION
     * ---------------------------------------------------------------- */

    function isJunkElement(el) {
      if (!el || el.nodeType !== 1) return false;
      if (JUNK_TAGS.has(el.tagName)) return true;
      if (el.hasAttribute("role")) {
        const role = el.getAttribute("role");
        if (role === "navigation" || role === "banner" || role === "contentinfo") {
          return true;
        }
      }
      const signature = (el.className && typeof el.className === "string" ? el.className : "") + " " + (el.id || "");
      if (JUNK_PATTERN.test(signature)) return true;
      return false;
    }

    function isInsideJunk(el) {
      let node = el.parentElement;
      while (node) {
        if (isJunkElement(node)) return true;
        node = node.parentElement;
      }
      return false;
    }

    // Picks the element most likely to hold the page's real study content.
    function findMainContainer() {
      const candidates = [
        "article",
        "main",
        '[role="main"]',
        ".article",
        ".post-content",
        ".entry-content"
      ];

      for (const selector of candidates) {
        const el = document.querySelector(selector);
        if (el && !isJunkElement(el) && countWords(el.innerText || "") > MIN_TEXT_FOR_CONTAINER) {
          return el;
        }
      }

      // Fallback: score each reasonably sized block element by how much
      // paragraph text it directly contains, and pick the best one.
      const blocks = Array.from(document.body.querySelectorAll("div, section"));
      let best = null;
      let bestScore = 0;

      for (const block of blocks) {
        if (isJunkElement(block) || isInsideJunk(block)) continue;
        const paragraphs = block.querySelectorAll("p");
        if (paragraphs.length < 2) continue;
        const score = Array.from(paragraphs).reduce(
          (sum, p) => sum + (p.innerText || "").length,
          0
        );
        if (score > bestScore) {
          bestScore = score;
          best = block;
        }
      }

      return best || document.body;
    }

    const MIN_TEXT_FOR_CONTAINER = 40; // words

    function countWords(text) {
      const trimmed = (text || "").trim();
      if (!trimmed) return 0;
      return trimmed.split(/\s+/).length;
    }

    function cleanText(text) {
      return text.replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
    }

    // Walks the chosen container in document order and builds a clean,
    // structured text version of it (headings, paragraphs, lists, tables,
    // and code blocks). This is what gets sent to the AI - never the raw
    // page HTML or unrelated parts of the page.
    function extractStructuredText(container) {
      const lines = [];
      const seen = new Set(); // avoids repeated boilerplate lines

      function addLine(line) {
        const clean = cleanText(line);
        if (!clean) return;
        const key = clean.toLowerCase();
        if (seen.has(key)) return; // skip exact repeats (e.g. repeated CTAs)
        seen.add(key);
        lines.push(clean);
      }

      function walk(node) {
        if (node.nodeType !== 1) return;
        if (isJunkElement(node)) return;

        const tag = node.tagName;

        if (/^H[1-6]$/.test(tag)) {
          addLine("\n" + node.innerText.toUpperCase());
          return; // headings don't need their children walked separately
        }

        if (tag === "P") {
          addLine(node.innerText);
          return;
        }

        if (tag === "PRE" || tag === "CODE") {
          const code = node.innerText.trim();
          if (code) addLine("```\n" + code + "\n```");
          return;
        }

        if (tag === "UL" || tag === "OL") {
          Array.from(node.children).forEach((li) => {
            if (li.tagName === "LI") addLine("• " + li.innerText);
          });
          return;
        }

        if (tag === "TABLE") {
          Array.from(node.querySelectorAll("tr")).forEach((row) => {
            const cells = Array.from(row.querySelectorAll("th, td")).map((c) =>
              c.innerText.trim()
            );
            if (cells.some((c) => c)) addLine(cells.join(" | "));
          });
          return;
        }

        // Keep looking inside generic containers.
        if (["DIV", "SECTION", "ARTICLE", "MAIN", "SPAN", "BLOCKQUOTE"].includes(tag)) {
          Array.from(node.children).forEach(walk);
        }
      }

      Array.from(container.children).forEach(walk);

      // If nothing structured was found (rare), fall back to plain text.
      if (lines.length === 0) {
        addLine(container.innerText || "");
      }

      return cleanText(lines.join("\n\n"));
    }

    function getPageTitle() {
      const h1 = document.querySelector("h1");
      if (h1 && h1.innerText.trim().length > 3) return h1.innerText.trim();
      return document.title.trim() || "Untitled page";
    }

    function readPage() {
      mainContainerEl = findMainContainer();
      const textContent = extractStructuredText(mainContainerEl);
      const wordCount = countWords(textContent);
      const preview = textContent.slice(0, 320);

      return {
        title: getPageTitle(),
        domain: location.hostname.replace(/^www\./, ""),
        url: location.href,
        wordCount,
        textContent,
        preview
      };
    }

    /* ---------------------------------------------------------------- *
     *  2. HIGHLIGHTING
     * ---------------------------------------------------------------- */

    function escapeForRegex(str) {
      return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }

    // Builds a whitespace-tolerant, case-insensitive matcher for a phrase
    // so small spacing differences between the AI's wording and the page's
    // actual text don't prevent a match.
    function buildPhraseRegex(phrase) {
      const words = phrase.trim().split(/\s+/).map(escapeForRegex);
      if (words.length === 0) return null;
      return new RegExp(words.join("\\s+"), "i");
    }

    function highlightPhraseInContainer(container, phrase, index) {
      const regex = buildPhraseRegex(phrase);
      if (!regex) return false;

      const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
        acceptNode(node) {
          if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
          if (isJunkElement(node.parentElement) || isInsideJunk(node.parentElement)) {
            return NodeFilter.FILTER_REJECT;
          }
          if (node.parentElement && node.parentElement.classList.contains(HIGHLIGHT_CLASS)) {
            return NodeFilter.FILTER_REJECT;
          }
          return NodeFilter.FILTER_ACCEPT;
        }
      });

      let node;
      while ((node = walker.nextNode())) {
        const match = regex.exec(node.nodeValue);
        if (!match) continue;

        const range = document.createRange();
        range.setStart(node, match.index);
        range.setEnd(node, match.index + match[0].length);

        const mark = document.createElement("mark");
        mark.className = HIGHLIGHT_CLASS;
        mark.dataset.studylensIndex = String(index);
        mark.title = "Highlighted by StudyLens";

        try {
          range.surroundContents(mark);
        } catch (err) {
          // surroundContents fails if the range crosses element boundaries;
          // skip this match rather than risk breaking the page's layout.
          continue;
        }

        return mark;
      }

      return null;
    }

    function applyHighlights(phrases) {
      if (!mainContainerEl) mainContainerEl = findMainContainer();

      const newMarks = [];
      let index = highlightElements.length;

      (phrases || [])
        .map((p) => (p || "").trim())
        .filter((p) => p.length >= MIN_PHRASE_LENGTH)
        .forEach((phrase) => {
          const mark = highlightPhraseInContainer(mainContainerEl, phrase, index);
          if (mark) {
            newMarks.push(mark);
            index += 1;
          }
        });

      highlightElements = highlightElements.concat(newMarks);

      // Keep highlight numbering in reading order (top to bottom) so
      // Next/Previous moves through the page the way a student reads it.
      highlightElements.sort((a, b) =>
        a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1
      );
      highlightElements.forEach((el, i) => {
        el.dataset.studylensIndex = String(i);
      });

      return {
        found: newMarks.length,
        requested: (phrases || []).length,
        total: highlightElements.length
      };
    }

    function removeHighlights() {
      const marks = Array.from(document.querySelectorAll("." + HIGHLIGHT_CLASS));
      marks.forEach((mark) => {
        const parent = mark.parentNode;
        if (!parent) return;
        const textNode = document.createTextNode(mark.textContent);
        parent.replaceChild(textNode, mark);
        parent.normalize();
      });
      highlightElements = [];
    }

    function scrollToHighlight(index) {
      const el = highlightElements[index];
      if (!el) return { index, total: highlightElements.length, found: false };

      el.scrollIntoView({ behavior: "smooth", block: "center" });
      el.classList.add(HIGHLIGHT_FOCUS_CLASS);
      setTimeout(() => el.classList.remove(HIGHLIGHT_FOCUS_CLASS), 1400);

      return { index, total: highlightElements.length, found: true };
    }

    /* ---------------------------------------------------------------- *
     *  3. MESSAGE HANDLING
     * ---------------------------------------------------------------- */

    chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
      try {
        switch (message && message.type) {
          case MSG.PING:
            sendResponse({ ok: true });
            break;

          case MSG.READ_PAGE:
            sendResponse({ ok: true, data: readPage() });
            break;

          case MSG.HIGHLIGHT_CONTENT:
            sendResponse({ ok: true, ...applyHighlights(message.phrases) });
            break;

          case MSG.REMOVE_HIGHLIGHTS:
            removeHighlights();
            sendResponse({ ok: true });
            break;

          case MSG.SCROLL_TO_HIGHLIGHT:
            sendResponse({ ok: true, ...scrollToHighlight(message.index) });
            break;

          default:
            sendResponse({ ok: false, error: "Unknown message type." });
        }
      } catch (err) {
        sendResponse({ ok: false, error: err.message || "Content script error." });
      }
      return true;
    });
  })();
}
