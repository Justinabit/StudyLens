/*
  fileParser.js
  -------------
  Turns an uploaded File into clean, structured text StudyLens can send to
  the AI - the same job content.js does for a webpage, but for documents.

  Kept separate from the AI logic and the UI on purpose (see README >
  File Extraction vs AI Analysis):
    FILE PARSER (this file)  -> extracts text
    AI SERVICE (aiService.js) -> understands and organizes it
    UI (sidepanel.js)         -> displays results

  Runs entirely inside the side panel document, using libraries vendored
  in /vendor (no CDN, no remote code - see README > Privacy & Dependencies).
  Uploaded files are treated as untrusted input: StudyLens only ever reads
  text out of them. It never executes macros, scripts, or embedded content.

  Output uses light Markdown (# headings, "- " bullets), matching content.js,
  so the AI sees the document's structure the same way for every source.
*/

// Thrown for any file StudyLens can identify a specific, friendly reason
// for rejecting. "kind" lets the UI choose an icon/tone if useful.
class FileParseError extends Error {
  constructor(kind, message) {
    super(message);
    this.name = "FileParseError";
    this.kind = kind;
  }
}

const CSV_MAX_ROWS = 500; // keep very large spreadsheets from producing an unusable wall of text
const CORRUPT_FILE_MESSAGE =
  "StudyLens couldn't read this file. Please make sure the file isn't corrupted or password-protected.";

/* ---------------------------------------------------------------------- *
 *  Small shared helpers (kept local to this file, same pattern as content.js)
 * ---------------------------------------------------------------------- */

function cleanWhitespaceFP(text) {
  return (text || "")
    .replace(/\r\n?/g, "\n")
    .replace(/[ \t ]+/g, " ")
    .replace(/ *\n */g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function countWordsFP(text) {
  const trimmed = (text || "").trim();
  return trimmed ? trimmed.split(/\s+/).length : 0;
}

function extensionOf(filename) {
  const parts = (filename || "").toLowerCase().split(".");
  return parts.length > 1 ? parts.pop() : "";
}

/* ---------------------------------------------------------------------- *
 *  PDF (via pdf.js, loaded lazily so it's never fetched unless needed)
 * ---------------------------------------------------------------------- */

let pdfjsLibPromise = null;

function getPdfjsLib() {
  if (!pdfjsLibPromise) {
    pdfjsLibPromise = import(chrome.runtime.getURL("vendor/pdfjs/pdf.min.mjs")).then((lib) => {
      lib.GlobalWorkerOptions.workerSrc = chrome.runtime.getURL("vendor/pdfjs/pdf.worker.min.mjs");
      return lib;
    });
  }
  return pdfjsLibPromise;
}

async function parsePDF(arrayBuffer, onProgress) {
  const pdfjsLib = await getPdfjsLib();

  let pdf;
  try {
    pdf = await pdfjsLib.getDocument({ data: arrayBuffer }).promise;
  } catch (err) {
    if (err && err.name === "PasswordException") {
      throw new FileParseError("password", "This PDF is password-protected. Remove the password and upload it again.");
    }
    throw new FileParseError("corrupt", CORRUPT_FILE_MESSAGE);
  }

  try {
    const numPages = pdf.numPages;
    const pageBlocks = [];
    let totalReadableChars = 0;

    for (let i = 1; i <= numPages; i++) {
      if (onProgress) onProgress("Reading PDF page " + i + " of " + numPages + "…", i / numPages);
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      // hasEOL marks the end of a visual line - keeping those breaks
      // preserves headings, bullets, and paragraphs instead of one long run.
      const pageText = content.items.map((item) => (item.str || "") + (item.hasEOL ? "\n" : " ")).join("");
      totalReadableChars += pageText.replace(/\s/g, "").length;
      const cleaned = cleanWhitespaceFP(pageText);
      if (cleaned) pageBlocks.push("## Page " + i + "\n" + cleaned);
      page.cleanup();
    }

    return {
      text: pageBlocks.join("\n\n"),
      pages: numPages,
      scanned: totalReadableChars / Math.max(numPages, 1) < 20 // almost no text per page = likely scanned images
    };
  } finally {
    pdf.destroy();
  }
}

/* ---------------------------------------------------------------------- *
 *  DOCX (via mammoth -> HTML) and HTML files share one structured walk
 * ---------------------------------------------------------------------- */

async function parseDOCX(arrayBuffer) {
  let result;
  try {
    result = await mammoth.convertToHtml({ arrayBuffer });
  } catch (err) {
    throw new FileParseError("corrupt", CORRUPT_FILE_MESSAGE);
  }
  const doc = new DOMParser().parseFromString(result.value, "text/html");
  return { text: structuredTextFromHtml(doc.body) };
}

function parseHTMLFile(rawText) {
  const doc = new DOMParser().parseFromString(rawText, "text/html");
  doc.querySelectorAll("script, style, noscript, template, iframe, nav, footer, form, button, svg").forEach((n) => n.remove());
  return { text: structuredTextFromHtml(doc.body || doc.documentElement) };
}

// Mirrors content.js's approach so headings, lists, and tables come out in
// the same style everywhere in StudyLens. Uses textContent because parsed
// documents aren't rendered (innerText needs layout).
function structuredTextFromHtml(container) {
  const blocks = [];
  const inlineText = (node) => (node.textContent || "").replace(/\s+/g, " ").trim();

  function walkList(list, depth, lines) {
    let number = 1;
    Array.from(list.children).forEach((item) => {
      if (item.tagName !== "LI") return;
      const nested = [];
      let own = "";
      item.childNodes.forEach((child) => {
        if (child.nodeType === 1 && (child.tagName === "UL" || child.tagName === "OL")) nested.push(child);
        else own += " " + (child.textContent || "");
      });
      own = own.replace(/\s+/g, " ").trim();
      if (own) lines.push("  ".repeat(depth) + (list.tagName === "OL" ? number++ + ". " : "- ") + own);
      nested.forEach((sub) => walkList(sub, depth + 1, lines));
    });
  }

  function walk(node) {
    if (node.nodeType !== 1) return;
    const tag = node.tagName;

    if (/^H[1-6]$/.test(tag)) {
      const text = inlineText(node);
      if (text) blocks.push("#".repeat(Number(tag[1])) + " " + text);
      return;
    }
    if (tag === "P" || tag === "BLOCKQUOTE" || tag === "FIGCAPTION" || tag === "DT" || tag === "DD") {
      const text = inlineText(node);
      if (text) blocks.push(text);
      return;
    }
    if (tag === "PRE") {
      const code = (node.textContent || "").replace(/\s+$/, "");
      if (code.trim()) blocks.push("```\n" + code + "\n```");
      return;
    }
    if (tag === "UL" || tag === "OL") {
      const lines = [];
      walkList(node, 0, lines);
      if (lines.length) blocks.push(lines.join("\n"));
      return;
    }
    if (tag === "TABLE") {
      const rows = Array.from(node.querySelectorAll("tr"))
        .map((row) => Array.from(row.querySelectorAll("th, td")).map(inlineText))
        .filter((cells) => cells.some((c) => c))
        .map((cells) => cells.join(" | "));
      if (rows.length) blocks.push(rows.join("\n"));
      return;
    }

    // Generic container: keep loose text between its block children.
    let loose = "";
    const flush = () => {
      const text = loose.replace(/\s+/g, " ").trim();
      if (text) blocks.push(text);
      loose = "";
    };
    node.childNodes.forEach((child) => {
      if (child.nodeType === 3) loose += child.nodeValue;
      else if (child.nodeType === 1 && /^(A|B|STRONG|I|EM|U|SPAN|SUB|SUP|CODE|SMALL|MARK|ABBR|CITE|Q|S|TIME|LABEL)$/.test(child.tagName)) {
        loose += child.textContent;
      } else if (child.nodeType === 1 && child.tagName === "BR") {
        loose += " ";
      } else {
        flush();
        walk(child);
      }
    });
    flush();
  }

  walk(container);
  return cleanWhitespaceFP(blocks.join("\n\n"));
}

/* ---------------------------------------------------------------------- *
 *  PPTX (via JSZip - PowerPoint files are a zip of slide XML files)
 * ---------------------------------------------------------------------- */

function parseXML(text) {
  return new DOMParser().parseFromString(text, "application/xml");
}

async function readZipXML(zip, path) {
  const file = zip.file(path);
  return file ? parseXML(await file.async("string")) : null;
}

// Resolves a relationship target ("../notesSlides/notesSlide3.xml") against
// the folder of the part that references it ("ppt/slides").
function resolveZipPath(baseDir, target) {
  if (target.startsWith("/")) return target.slice(1);
  const parts = baseDir.split("/").filter(Boolean);
  target.split("/").forEach((segment) => {
    if (segment === "..") parts.pop();
    else if (segment && segment !== ".") parts.push(segment);
  });
  return parts.join("/");
}

async function readRelationships(zip, relsPath, baseDir) {
  const doc = await readZipXML(zip, relsPath);
  const rels = {};
  if (!doc) return rels;
  Array.from(doc.getElementsByTagName("Relationship")).forEach((rel) => {
    rels[rel.getAttribute("Id")] = {
      type: rel.getAttribute("Type") || "",
      path: resolveZipPath(baseDir, rel.getAttribute("Target") || "")
    };
  });
  return rels;
}

// The real slide order lives in presentation.xml; slide file numbers
// don't change when slides are reordered in PowerPoint.
async function pptxSlidePaths(zip) {
  const presentation = await readZipXML(zip, "ppt/presentation.xml");
  if (presentation) {
    const rels = await readRelationships(zip, "ppt/_rels/presentation.xml.rels", "ppt");
    const ordered = Array.from(presentation.getElementsByTagName("p:sldId"))
      .map((node) => rels[node.getAttribute("r:id")])
      .filter((rel) => rel && zip.file(rel.path))
      .map((rel) => rel.path);
    if (ordered.length) return ordered;
  }
  const slideNumber = (name) => parseInt(name.match(/slide(\d+)\.xml$/)[1], 10);
  return Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => slideNumber(a) - slideNumber(b));
}

function placeholderType(paragraph) {
  let node = paragraph.parentNode;
  while (node && node.nodeName !== "p:sp") node = node.parentNode;
  const ph = node && node.getElementsByTagName("p:ph")[0];
  return ph ? ph.getAttribute("type") || "body" : "";
}

function paragraphText(paragraph) {
  return Array.from(paragraph.getElementsByTagName("a:t"))
    .map((t) => t.textContent)
    .join("")
    .replace(/\s+/g, " ")
    .trim();
}

async function parsePPTX(arrayBuffer, onProgress) {
  let zip;
  try {
    zip = await JSZip.loadAsync(arrayBuffer);
  } catch (err) {
    throw new FileParseError("corrupt", CORRUPT_FILE_MESSAGE);
  }

  const slidePaths = await pptxSlidePaths(zip);
  if (slidePaths.length === 0) {
    throw new FileParseError("corrupt", "StudyLens couldn't find any slides in this file.");
  }

  const slideBlocks = [];
  for (let i = 0; i < slidePaths.length; i++) {
    if (onProgress) onProgress("Extracting slide " + (i + 1) + " of " + slidePaths.length + "…", (i + 1) / slidePaths.length);

    const slideDoc = await readZipXML(zip, slidePaths[i]);
    let title = "";
    const body = [];
    Array.from(slideDoc.getElementsByTagName("a:p")).forEach((p) => {
      const text = paragraphText(p);
      if (!text) return;
      const type = placeholderType(p);
      if ((type === "title" || type === "ctrTitle") && !title) title = text;
      else if (type !== "sldNum" && type !== "dt" && type !== "ftr") body.push("- " + text);
    });

    // Speaker notes are linked from the slide's own relationships file.
    const dir = slidePaths[i].slice(0, slidePaths[i].lastIndexOf("/"));
    const file = slidePaths[i].slice(dir.length + 1);
    const rels = await readRelationships(zip, dir + "/_rels/" + file + ".rels", dir);
    const notesRel = Object.values(rels).find((rel) => /\/notesSlide$/.test(rel.type));
    let notes = "";
    if (notesRel) {
      const notesDoc = await readZipXML(zip, notesRel.path);
      if (notesDoc) {
        notes = Array.from(notesDoc.getElementsByTagName("a:p"))
          .filter((p) => !["sldNum", "sldImg", "hdr", "ftr", "dt"].includes(placeholderType(p)))
          .map(paragraphText)
          .filter((t) => t && !/^\d+$/.test(t))
          .join(" ");
      }
    }

    let block = "## Slide " + (i + 1) + (title ? ": " + title : "");
    block += "\n" + (body.length ? body.join("\n") : "(no readable text on this slide)");
    if (notes) block += "\nSpeaker notes: " + notes;
    slideBlocks.push(block);
  }

  return { text: slideBlocks.join("\n\n"), slideCount: slidePaths.length };
}

/* ---------------------------------------------------------------------- *
 *  TXT / Markdown / CSV / RTF (no external library needed)
 * ---------------------------------------------------------------------- */

function parseMarkdown(rawText) {
  // StudyLens already speaks Markdown, so headings and lists are kept.
  // Only syntax that adds noise without meaning is removed.
  let text = rawText.replace(/\r\n?/g, "\n");
  text = text.replace(/^---\n[\s\S]*?\n---\n/, ""); // front matter
  text = text.replace(/<!--[\s\S]*?-->/g, "");
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1"); // images -> alt text
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1"); // links -> link text
  text = text.replace(/<\/?[a-z][^>]*>/gi, ""); // inline HTML tags
  return { text: cleanWhitespaceFP(text) };
}

function parseCSV(rawText) {
  const parsed = Papa.parse(rawText.trim(), { skipEmptyLines: true });
  const rows = parsed.data;
  if (!rows.length) return { text: "" };

  const header = rows[0];
  const dataRows = rows.slice(1);
  const truncated = dataRows.length > CSV_MAX_ROWS;
  const rowsToUse = truncated ? dataRows.slice(0, CSV_MAX_ROWS) : dataRows;

  const lines = rowsToUse.map((row) =>
    header.map((h, idx) => (h || "Column " + (idx + 1)) + ": " + (row[idx] !== undefined ? row[idx] : "")).join(" | ")
  );
  if (truncated) {
    lines.push("\n(StudyLens only read the first " + CSV_MAX_ROWS + " of " + dataRows.length + " rows in this file.)");
  }

  return { text: cleanWhitespaceFP(lines.join("\n")), rowCount: dataRows.length, truncated };
}

// RTF has no vendored parser (see README > Limitations) - this is a small,
// best-effort reader rather than a full RTF implementation. It drops whole
// non-text groups (font tables, styles, pictures) by tracking braces, then
// strips the remaining control words.
const RTF_SKIP_GROUPS = /^\\(?:\*|fonttbl|colortbl|stylesheet|info|pict|header|footer|listtable|listoverridetable|rsidtbl|themedata|datastore|latentstyles|generator|xmlnstbl)/;

function parseRTF(rawText) {
  let out = "";
  let depth = 0;
  let skipUntilDepth = -1;

  for (let i = 0; i < rawText.length; i++) {
    const ch = rawText[i];
    if (ch === "{") {
      depth += 1;
      if (skipUntilDepth === -1 && RTF_SKIP_GROUPS.test(rawText.slice(i + 1, i + 40))) skipUntilDepth = depth;
      continue;
    }
    if (ch === "}") {
      if (depth === skipUntilDepth) skipUntilDepth = -1;
      depth -= 1;
      continue;
    }
    if (skipUntilDepth === -1) out += ch;
  }

  let text = out;
  text = text.replace(/\\u(-?\d+)\??/g, (match, code) => String.fromCharCode((Number(code) + 65536) % 65536));
  text = text.replace(/\\'([0-9a-fA-F]{2})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
  text = text.replace(/\\(?:par|line)\b ?/g, "\n");
  text = text.replace(/\\tab\b ?/g, "\t");
  text = text.replace(/\\[a-zA-Z]+-?\d* ?/g, "");
  text = text.replace(/\\([\\{}])/g, "$1");
  return { text: cleanWhitespaceFP(text), bestEffort: true };
}

/* ---------------------------------------------------------------------- *
 *  Dispatcher
 *  onProgress(message, fraction?) reports the parser's real, current step.
 * ---------------------------------------------------------------------- */

async function extractFileContent(file, onProgress) {
  const ext = extensionOf(file.name);
  const kind = ext === "markdown" ? "md" : ext === "htm" ? "html" : ext;
  const progress = (message, fraction) => onProgress && onProgress(message, fraction);

  if (!FILE_SUPPORT.extensions.includes(ext)) {
    throw new FileParseError("unsupported", "That file type isn't supported. Try a PDF, Word, PowerPoint, TXT, Markdown, CSV, RTF, or HTML file.");
  }
  if (file.size > FILE_SUPPORT.maxSizeBytes) {
    throw new FileParseError("too-large", "File is too large. Please upload a file smaller than " + FILE_SUPPORT.maxSizeLabel + ".");
  }
  if (file.size === 0) {
    throw new FileParseError("empty", "This file is empty.");
  }

  let result;
  if (kind === "pdf") {
    progress("Opening PDF…");
    result = await parsePDF(await file.arrayBuffer(), progress);
  } else if (kind === "docx") {
    progress("Reading Word document…");
    result = await parseDOCX(await file.arrayBuffer());
  } else if (kind === "pptx") {
    progress("Opening PowerPoint…");
    result = await parsePPTX(await file.arrayBuffer(), progress);
  } else if (kind === "txt") {
    progress("Reading text…");
    result = { text: cleanWhitespaceFP(await file.text()) };
  } else if (kind === "md") {
    progress("Reading Markdown…");
    result = parseMarkdown(await file.text());
  } else if (kind === "csv") {
    progress("Reading spreadsheet rows…");
    result = parseCSV(await file.text());
  } else if (kind === "rtf") {
    progress("Reading document…");
    result = parseRTF(await file.text());
  } else if (kind === "html") {
    progress("Reading web page file…");
    result = parseHTMLFile(await file.text());
  }

  progress("Checking the extracted text…", 1);
  const wordCount = countWordsFP(result.text);

  if (wordCount < MIN_WORD_COUNT) {
    if (kind === "pdf" && result.scanned) {
      throw new FileParseError(
        "scanned",
        "This PDF looks like scanned images rather than selectable text. OCR isn't available in StudyLens yet - " +
          "try a text-based PDF or another supported document."
      );
    }
    throw new FileParseError(
      "empty",
      "StudyLens couldn't find enough readable text in this file (it found " + wordCount + " words)."
    );
  }

  return {
    kind,
    text: result.text,
    wordCount,
    pages: result.pages,
    slideCount: result.slideCount,
    rowCount: result.rowCount,
    truncated: !!result.truncated,
    bestEffort: !!result.bestEffort
  };
}
