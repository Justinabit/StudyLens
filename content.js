/*
  content.js
  ----------
  Runs inside the current webpage, but ONLY after the student clicks
  "Scan this page" (StudyLens uses chrome.scripting to inject this file on
  demand - it is never present on a page the student didn't ask about).

  Responsibilities:
    1. Extract meaningful, study-worthy text from the page.
    2. Highlight important passages the student asked to see.
    3. Remove those highlights again, restoring the original page.
    4. Scroll to a specific highlight for review.

  This file intentionally avoids frameworks and keeps the DOM changes small
  and reversible (see README > How Highlighting Works).
*/

(function () {
  "use strict";

  // If the extension was reloaded, an older copy of this script may still
  // be attached to the page with a dead connection. The side panel only
  // injects when its PING goes unanswered, so replacing that copy's
  // listener here is always safe.
  if (window.__studylensListener) {
    try {
      chrome.runtime.onMessage.removeListener(window.__studylensListener);
    } catch (err) {
      // The old listener belonged to an extension context that no longer exists.
    }
  }

  // Local copy of the message names StudyLens uses (kept in sync with
  // constants.js by hand, since content scripts run in an isolated world and
  // this keeps the file a single, self-contained unit).
  const MSG = {
    PING: "PING",
    READ_PAGE: "READ_PAGE",
    HIGHLIGHT_CONTENT: "HIGHLIGHT_CONTENT",
    REMOVE_HIGHLIGHTS: "REMOVE_HIGHLIGHTS",
    SCROLL_TO_HIGHLIGHT: "SCROLL_TO_HIGHLIGHT",
    HIGHLIGHT_STATUS: "HIGHLIGHT_STATUS"
  };

  const HIGHLIGHT_CLASS = "studylens-highlight";
  const HIGHLIGHT_FOCUS_CLASS = "studylens-highlight-focus";
  const MIN_PHRASE_LENGTH = 12; // characters
  const MIN_CONTAINER_TEXT = 400; // characters of paragraph-like text

  // Elements that are never study content.
  const SKIP_TAGS = new Set([
    "SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "IFRAME", "SVG", "CANVAS", "VIDEO", "AUDIO",
    "BUTTON", "INPUT", "SELECT", "OPTION", "TEXTAREA", "DIALOG", "OBJECT", "EMBED"
  ]);
  // Page furniture: skipped unless it holds most of the page's text (some
  // sites put the whole article inside, e.g., an <aside> or a "has-sidebar" div).
  const FURNITURE_TAGS = new Set(["NAV", "ASIDE", "FOOTER", "HEADER"]);
  const FURNITURE_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search", "menu", "menubar", "toolbar"]);
  // Matched against whole class/id words ("site-header", "nav_menu"), so
  // "canvas" or "heading" no longer count as "nav" or "header".
  const FURNITURE_WORDS = new RegExp(
    "(?:^|[\\s_-])(?:nav|navbar|navbox|navigation|menu|menubar|sidebar|footer|header|masthead|breadcrumbs?|" +
      "pagination|pager|advert|advertisement|ads?|adsbygoogle|sponsored|promo|banner|cookies?|consent|gdpr|popup|" +
      "modal|social|share|sharing|comments?|related|recommended|recommendations|subscribe|newsletter|signup|" +
      "signin|login|toolbar|skip|toc|noprint|catlinks|mw-editsection)(?:$|[\\s_-])",
    "i"
  );
  const BLOCK_TAGS = new Set([
    "ADDRESS", "ARTICLE", "ASIDE", "BLOCKQUOTE", "DETAILS", "DD", "DIV", "DL", "DT", "FIELDSET", "FIGCAPTION",
    "FIGURE", "FOOTER", "FORM", "H1", "H2", "H3", "H4", "H5", "H6", "HEADER", "HGROUP", "HR", "LI", "MAIN", "NAV",
    "OL", "P", "PRE", "SECTION", "SUMMARY", "TABLE", "TBODY", "THEAD", "TFOOT", "TR", "TD", "TH", "CAPTION", "UL"
  ]);
  const BLOCK_SELECTOR = "p, div, section, article, ul, ol, table, h1, h2, h3, h4, h5, h6, pre, blockquote, li";
  // Never insert a <mark> directly inside these (it would break the markup).
  const STRUCTURAL_PARENTS = new Set(["UL", "OL", "DL", "TABLE", "TBODY", "THEAD", "TFOOT", "TR", "SELECT", "COLGROUP"]);
  const CITATION_PATTERN = /\[(?:\d{1,3}|[a-z]|edit|citation needed|note \d+)\]/gi;

  // Kept between messages so Highlight/Remove/Scroll act on the same
  // container that was actually read.
  let mainContainerEl = null;
  let groups = []; // one entry per highlighted passage: { marks: [<mark>…], text }

  /* ---------------------------------------------------------------- *
   *  1. CONTENT EXTRACTION
   * ---------------------------------------------------------------- */

  function isHidden(el) {
    if (el.hidden || el.getAttribute("aria-hidden") === "true") return true;
    const style = window.getComputedStyle(el);
    return style.display === "none" || style.visibility === "hidden";
  }

  function looksLikeFurniture(el) {
    if (FURNITURE_TAGS.has(el.tagName)) {
      // An <header> inside an <article> is the article's own header.
      if (el.tagName === "HEADER" && el.parentElement && el.parentElement.closest("article")) return false;
      return true;
    }
    const role = el.getAttribute("role");
    if (role && FURNITURE_ROLES.has(role)) return true;
    const signature = (typeof el.className === "string" ? el.className : "") + " " + (el.id || "");
    return FURNITURE_WORDS.test(signature);
  }

  // containerTextLength guards against false positives: furniture never
  // holds the majority of the page's text.
  function isJunkElement(el, containerTextLength) {
    if (!el || el.nodeType !== 1) return false;
    if (SKIP_TAGS.has(el.tagName)) return true;
    if (!looksLikeFurniture(el)) return false;
    return !(containerTextLength && (el.textContent || "").length > containerTextLength * 0.5);
  }

  function paragraphTextLength(el) {
    let total = 0;
    el.querySelectorAll("p, li, pre, blockquote, dd, td").forEach((node) => {
      total += (node.textContent || "").length;
    });
    return total;
  }

  // Picks the element most likely to hold the page's real study content.
  function findMainContainer() {
    const semantic = Array.from(
      document.querySelectorAll(
        'article, main, [role="main"], #mw-content-text, .markdown-body, .post-content, .entry-content, .article-body, .article-content, #content'
      )
    ).filter((el) => !SKIP_TAGS.has(el.tagName) && !isHidden(el));

    let best = null;
    let bestScore = 0;
    semantic.forEach((el) => {
      const score = paragraphTextLength(el);
      if (score > bestScore) {
        best = el;
        bestScore = score;
      }
    });
    if (best && bestScore >= MIN_CONTAINER_TEXT) return best;

    // Fallback: score each block by how much paragraph text it directly
    // contains, and pick the best one.
    let fallback = null;
    let fallbackScore = 0;
    document.body.querySelectorAll("div, section, td").forEach((block) => {
      if (looksLikeFurniture(block)) return;
      let score = 0;
      Array.from(block.children).forEach((child) => {
        if (child.tagName === "P" || child.tagName === "PRE" || child.tagName === "UL" || child.tagName === "OL") {
          score += (child.textContent || "").length;
        }
      });
      if (score > fallbackScore) {
        fallbackScore = score;
        fallback = block;
      }
    });

    return fallbackScore >= MIN_CONTAINER_TEXT ? fallback : document.body;
  }

  function countWords(text) {
    const trimmed = (text || "").trim();
    return trimmed ? trimmed.split(/\s+/).length : 0;
  }

  function cleanInline(text) {
    return (text || "").replace(CITATION_PATTERN, "").replace(/\s+/g, " ").trim();
  }

  // Walks the chosen container in document order and builds a clean,
  // Markdown-flavored text version of it (headings, paragraphs, lists,
  // tables, code). This is what gets sent to the AI - never the raw page
  // HTML or unrelated parts of the page.
  function extractStructuredText(container) {
    const lines = [];
    const seen = new Set(); // skips repeated boilerplate (e.g. repeated CTAs)
    const containerTextLength = (container.textContent || "").length;

    // Lists and tables collect into their own block so their lines stay
    // together; everything else is one block per line.
    function addLine(text, prefix, block) {
      const clean = cleanInline(text);
      if (!clean) return;
      if (clean.length > 30) {
        const key = clean.toLowerCase();
        if (seen.has(key)) return;
        seen.add(key);
      }
      (block || lines).push((prefix || "") + clean);
    }

    function skip(el) {
      return isJunkElement(el, containerTextLength) || isHidden(el);
    }

    function isBlockish(el) {
      if (BLOCK_TAGS.has(el.tagName)) return true;
      // Custom elements and inline wrappers that contain real blocks.
      return !!el.firstElementChild && !!el.querySelector(BLOCK_SELECTOR);
    }

    function walkList(list, depth, block) {
      let number = 1;
      Array.from(list.children).forEach((item) => {
        if (item.tagName !== "LI" || skip(item)) return;
        let ownText = "";
        const nested = [];
        item.childNodes.forEach((child) => {
          if (child.nodeType === Node.TEXT_NODE) ownText += child.nodeValue;
          else if (child.nodeType === Node.ELEMENT_NODE) {
            if (child.tagName === "UL" || child.tagName === "OL") nested.push(child);
            else if (!skip(child)) ownText += " " + (child.innerText || "") + " ";
          }
        });
        const marker = list.tagName === "OL" ? number++ + ". " : "- ";
        addLine(ownText, "  ".repeat(depth) + marker, block);
        nested.forEach((sub) => walkList(sub, depth + 1, block));
      });
    }

    function walkTable(table) {
      // Old-style layout tables hold whole articles - walk their cells as
      // ordinary content instead of flattening them into one row.
      if (table.querySelector("table, p, h1, h2, h3, ul, ol, div div")) {
        table.querySelectorAll(":scope > * > tr > td, :scope > tr > td").forEach((cell) => walkMixed(cell));
        return;
      }
      const rows = [];
      Array.from(table.querySelectorAll("tr")).forEach((row) => {
        const cells = Array.from(row.querySelectorAll("th, td")).map((c) => cleanInline(c.innerText));
        if (cells.some((c) => c)) rows.push(cells.join(" | "));
      });
      if (rows.length) lines.push(rows.join("\n"));
    }

    function walk(el) {
      if (skip(el)) return;
      const tag = el.tagName;

      if (/^H[1-6]$/.test(tag)) {
        addLine(el.innerText, "#".repeat(Number(tag[1])) + " ");
        return;
      }
      if (tag === "P" || tag === "FIGCAPTION" || tag === "SUMMARY" || tag === "DT" || tag === "DD" || tag === "CAPTION") {
        addLine(el.innerText);
        return;
      }
      if (tag === "PRE") {
        const code = (el.innerText || "").replace(/\s+$/, "");
        if (code.trim()) lines.push("```\n" + code + "\n```");
        return;
      }
      if (tag === "UL" || tag === "OL") {
        const block = [];
        walkList(el, 0, block);
        if (block.length) lines.push(block.join("\n"));
        return;
      }
      if (tag === "TABLE") {
        walkTable(el);
        return;
      }
      walkMixed(el);
    }

    // Handles containers that mix loose text with block children, e.g.
    // <div>Some text<br>more text<p>…</p></div> - the loose text used to be
    // dropped entirely.
    function walkMixed(el) {
      let inline = "";
      const flush = () => {
        if (inline.trim()) addLine(inline);
        inline = "";
      };
      el.childNodes.forEach((node) => {
        if (node.nodeType === Node.TEXT_NODE) {
          inline += node.nodeValue;
        } else if (node.nodeType === Node.ELEMENT_NODE) {
          if (node.tagName === "BR") {
            inline += " ";
          } else if (isBlockish(node)) {
            flush();
            walk(node);
          } else if (!skip(node)) {
            inline += node.innerText || "";
          }
        }
      });
      flush();
    }

    walk(container);

    if (lines.length === 0) addLine(container.innerText || "");
    return lines.join("\n\n").replace(/\n{3,}/g, "\n\n").trim();
  }

  function getPageTitle() {
    const h1 = document.querySelector("h1");
    const h1Text = h1 ? cleanInline(h1.innerText) : "";
    if (h1Text.length > 3 && h1Text.length < 200) return h1Text;
    return document.title.trim() || "Untitled page";
  }

  function readPage() {
    mainContainerEl = findMainContainer();
    const textContent = extractStructuredText(mainContainerEl);

    return {
      title: getPageTitle(),
      domain: location.hostname.replace(/^www\./, ""),
      url: location.href,
      lang: document.documentElement.lang || "",
      wordCount: countWords(textContent),
      textContent,
      preview: textContent.slice(0, 600)
    };
  }

  /* ---------------------------------------------------------------- *
   *  2. HIGHLIGHTING
   *
   *  The AI returns exact quotes. A quote on a real page is usually split
   *  across several text nodes (links, bold words, citations), so the
   *  page's visible text is flattened into one normalized string with a
   *  map back to each character's text node. A match can then be wrapped
   *  piece by piece, one <mark> per text node it touches.
   * ---------------------------------------------------------------- */

  const CHAR_MAP = {
    "\u2018": "'", "\u2019": "'", "\u201a": "'", "\u201b": "'", "\u2032": "'",
    "\u201c": '"', "\u201d": '"', "\u201e": '"', "\u2033": '"',
    "\u2010": "-", "\u2011": "-", "\u2012": "-", "\u2013": "-", "\u2014": "-", "\u2212": "-",
    "\u00a0": " ", "\u2009": " ", "\u202f": " "
  };
  const ZERO_WIDTH = /[\u00ad\u200b-\u200d\u2060\ufeff]/;

  function normalizeChar(ch) {
    const mapped = CHAR_MAP[ch] || ch;
    const lower = mapped.toLowerCase();
    return lower.length === 1 ? lower : mapped; // keep the 1:1 character map
  }

  function isSpace(ch) {
    return ch === " " || ch === "\n" || ch === "\t" || ch === "\r" || ch === "\f";
  }

  function isCitationMarker(el) {
    return el.tagName === "SUP" && /^\s*\[[^\]]{1,20}\]\s*$/.test(el.textContent || "");
  }

  function buildTextIndex(container) {
    const containerTextLength = (container.textContent || "").length;
    const excludedCache = new Map();
    const blockCache = new Map();

    function excluded(el) {
      if (!el || el === container) return false;
      if (excludedCache.has(el)) return excludedCache.get(el);
      const result =
        el.classList.contains(HIGHLIGHT_CLASS) ||
        isCitationMarker(el) ||
        isJunkElement(el, containerTextLength) ||
        isHidden(el) ||
        excluded(el.parentElement);
      excludedCache.set(el, result);
      return result;
    }

    function nearestBlock(el) {
      let node = el;
      while (node && node !== container && !BLOCK_TAGS.has(node.tagName)) node = node.parentElement;
      return node || container;
    }

    const nodes = [];
    const chars = [];
    const owners = [];
    const offsets = [];
    let lastWasSpace = true;
    let lastBlock = null;

    const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.parentElement) return NodeFilter.FILTER_REJECT;
        return excluded(node.parentElement) ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT;
      }
    });

    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      const nodeIndex = nodes.push(node) - 1;
      const parent = node.parentElement;
      const block = blockCache.has(parent) ? blockCache.get(parent) : nearestBlock(parent);
      blockCache.set(parent, block);

      // Text from different paragraphs must not run together into one word.
      if (block !== lastBlock && !lastWasSpace) {
        chars.push(" ");
        owners.push(nodeIndex);
        offsets.push(0);
        lastWasSpace = true;
      }
      lastBlock = block;

      const value = node.nodeValue;
      for (let i = 0; i < value.length; i++) {
        const raw = value[i];
        if (ZERO_WIDTH.test(raw)) continue;
        let ch = normalizeChar(raw);
        if (isSpace(ch)) {
          if (lastWasSpace) continue;
          ch = " ";
          lastWasSpace = true;
        } else {
          lastWasSpace = false;
        }
        chars.push(ch);
        owners.push(nodeIndex);
        offsets.push(i);
      }
    }

    return { text: chars.join(""), nodes, owners, offsets };
  }

  function normalizePhrase(phrase) {
    const stripped = String(phrase || "")
      .replace(CITATION_PATTERN, "")
      .replace(/\*\*|__/g, "")
      .replace(/^[\s"'“”‘’•*#>-]+/, "")
      .replace(/["'“”‘’\s]+$/, "");
    let out = "";
    let lastWasSpace = true;
    for (const raw of stripped) {
      if (ZERO_WIDTH.test(raw)) continue;
      let ch = normalizeChar(raw);
      if (isSpace(ch)) {
        if (lastWasSpace) continue;
        ch = " ";
        lastWasSpace = true;
      } else {
        lastWasSpace = false;
      }
      out += ch;
    }
    return out.trim();
  }

  // Tries the exact quote first, then slightly looser versions, since the
  // AI occasionally changes a word near the end of a long quote.
  function phraseCandidates(phrase) {
    const full = normalizePhrase(phrase);
    const words = full.split(" ");
    const candidates = [full, full.replace(/[.;:,!?]+$/, "")];
    if (words.length >= 10) candidates.push(words.slice(0, 12).join(" "), words.slice(0, 8).join(" "));
    if (words.length >= 12) candidates.push(words.slice(-8).join(" "));
    return Array.from(new Set(candidates)).filter((c) => c.length >= MIN_PHRASE_LENGTH);
  }

  function findPhrase(index, phrase, taken) {
    for (const candidate of phraseCandidates(phrase)) {
      let from = 0;
      for (;;) {
        const start = index.text.indexOf(candidate, from);
        if (start === -1) break;
        const end = start + candidate.length;
        if (!taken.some((m) => start < m.end && end > m.start)) return { start, end };
        from = start + 1;
      }
    }
    return null;
  }

  function wrapPiece(node, startOffset, endOffset) {
    if (!node.parentNode || endOffset <= startOffset) return null;
    let target = node;
    if (startOffset > 0) target = target.splitText(startOffset);
    if (endOffset - startOffset < target.nodeValue.length) target.splitText(endOffset - startOffset);
    if (!target.nodeValue.trim() && STRUCTURAL_PARENTS.has(target.parentNode.nodeName)) return null;

    const mark = document.createElement("mark");
    mark.className = HIGHLIGHT_CLASS;
    mark.title = "Highlighted by StudyLens";
    target.parentNode.insertBefore(mark, target);
    mark.appendChild(target);
    return mark;
  }

  function wrapMatch(index, start, end) {
    const pieces = [];
    let i = start;
    while (i < end) {
      const owner = index.owners[i];
      const first = index.offsets[i];
      let last = first;
      while (i < end && index.owners[i] === owner) {
        last = index.offsets[i];
        i++;
      }
      pieces.push({ node: index.nodes[owner], start: first, end: last + 1 });
    }
    // Later pieces first, so offsets of earlier pieces stay valid.
    const marks = [];
    for (let k = pieces.length - 1; k >= 0; k--) {
      const mark = wrapPiece(pieces[k].node, pieces[k].start, pieces[k].end);
      if (mark) marks.unshift(mark);
    }
    return marks;
  }

  function groupSnippet(group) {
    const text = group.marks.map((m) => m.textContent).join("").replace(/\s+/g, " ").trim();
    return text.length > 160 ? text.slice(0, 157) + "…" : text;
  }

  function pruneGroups() {
    groups = groups
      .map((g) => ({ ...g, marks: g.marks.filter((m) => m.isConnected) }))
      .filter((g) => g.marks.length);
  }

  function sortAndNumberGroups() {
    groups.sort((a, b) => (a.marks[0].compareDocumentPosition(b.marks[0]) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1));
    groups.forEach((g, i) => g.marks.forEach((m) => (m.dataset.studylensIndex = String(i))));
  }

  function highlightSummary(extra) {
    return { total: groups.length, items: groups.map(groupSnippet), ...(extra || {}) };
  }

  function applyHighlights(phrases) {
    if (!mainContainerEl || !mainContainerEl.isConnected) mainContainerEl = findMainContainer();
    pruneGroups();

    const list = (phrases || []).filter((p) => typeof p === "string");
    const index = buildTextIndex(mainContainerEl);
    const matches = [];
    list.forEach((phrase) => {
      const match = findPhrase(index, phrase, matches);
      if (match) matches.push(match);
    });

    // Wrap from the end of the page backwards so earlier offsets stay valid.
    matches.sort((a, b) => b.start - a.start);
    const newGroups = matches
      .map((m) => ({ marks: wrapMatch(index, m.start, m.end) }))
      .filter((g) => g.marks.length);

    groups = groups.concat(newGroups);
    sortAndNumberGroups();
    return highlightSummary({ found: newGroups.length, requested: list.length });
  }

  function removeHighlights() {
    const parents = new Set();
    document.querySelectorAll("mark." + HIGHLIGHT_CLASS).forEach((mark) => {
      const parent = mark.parentNode;
      if (!parent) return;
      while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
      parent.removeChild(mark);
      parents.add(parent);
    });
    parents.forEach((p) => p.normalize());
    groups = [];
  }

  function scrollToHighlight(index) {
    pruneGroups();
    const group = groups[index];
    if (!group) return highlightSummary({ index, found: false });

    document.querySelectorAll("." + HIGHLIGHT_FOCUS_CLASS).forEach((el) => el.classList.remove(HIGHLIGHT_FOCUS_CLASS));
    void group.marks[0].offsetWidth; // restart the pulse animation
    group.marks.forEach((m) => m.classList.add(HIGHLIGHT_FOCUS_CLASS));
    group.marks[0].scrollIntoView({ behavior: "smooth", block: "center" });
    return highlightSummary({ index, found: true });
  }

  // Rebuild highlight groups left on the page by an earlier copy of this
  // script, so Previous/Next keep working after a re-injection.
  function adoptExistingHighlights() {
    const byIndex = new Map();
    document.querySelectorAll("mark." + HIGHLIGHT_CLASS).forEach((mark) => {
      const key = mark.dataset.studylensIndex || "x";
      if (!byIndex.has(key)) byIndex.set(key, []);
      byIndex.get(key).push(mark);
    });
    groups = Array.from(byIndex.values()).map((marks) => ({ marks }));
    if (groups.length) sortAndNumberGroups();
  }

  /* ---------------------------------------------------------------- *
   *  3. MESSAGE HANDLING
   * ---------------------------------------------------------------- */

  function onMessage(message, sender, sendResponse) {
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
        case MSG.HIGHLIGHT_STATUS:
          pruneGroups();
          sendResponse({ ok: true, ...highlightSummary() });
          break;
        default:
          return false; // not ours
      }
    } catch (err) {
      sendResponse({ ok: false, error: (err && err.message) || "Content script error." });
    }
    return false;
  }

  adoptExistingHighlights();
  window.__studylensListener = onMessage;
  chrome.runtime.onMessage.addListener(onMessage);
})();
