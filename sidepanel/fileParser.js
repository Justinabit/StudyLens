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
*/

// Thrown for any file StudyLens can identify a specific, friendly reason
// for rejecting. "kind" lets the UI choose an icon/tone if useful later.
class FileParseError extends Error {
  constructor(kind, message) {
    super(message);
    this.kind = kind;
  }
}

const CSV_MAX_ROWS = 500; // keep very large spreadsheets from producing an unusable wall of text

/* ---------------------------------------------------------------------- *
 *  Small shared helpers (kept local to this file, same pattern as content.js)
 * ---------------------------------------------------------------------- */

function cleanWhitespaceFP(text) {
  return (text || "").replace(/[ \t]+/g, " ").replace(/\n{3,}/g, "\n\n").trim();
}

function countWordsFP(text) {
  const trimmed = (text || "").trim();
  if (!trimmed) return 0;
  return trimmed.split(/\s+/).length;
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
  const loadingTask = pdfjsLib.getDocument({ data: arrayBuffer });

  let passwordProtected = false;
  loadingTask.onPassword = (_updatePassword, _reason) => {
    passwordProtected = true;
    loadingTask.destroy();
  };

  let pdf;
  try {
    pdf = await loadingTask.promise;
  } catch (err) {
    if (passwordProtected) {
      throw new FileParseError("password", "This file appears to be password-protected and cannot be read.");
    }
    throw new FileParseError(
      "corrupt",
      "StudyLens couldn't read this file. Please make sure the file isn't corrupted or password-protected."
    );
  }

  const numPages = pdf.numPages;
  const pageBlocks = [];
  let totalReadableChars = 0;

  for (let i = 1; i <= numPages; i++) {
    if (onProgress) onProgress("Reading PDF page " + i + " of " + numPages + "…");
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const pageText = content.items.map((item) => item.str).join(" ");
    totalReadableChars += pageText.replace(/\s/g, "").length;
    pageBlocks.push("PAGE " + i + "\n" + cleanWhitespaceFP(pageText));
  }

  const avgCharsPerPage = totalReadableChars / Math.max(numPages, 1);
  return {
    text: cleanWhitespaceFP(pageBlocks.join("\n\n")),
    pages: numPages,
    scanned: avgCharsPerPage < 20 // heuristic: almost no extractable text per page = likely scanned images
  };
}

/* ---------------------------------------------------------------------- *
 *  DOCX (via mammoth -> HTML -> the same heading/list/table walk content.js uses)
 * ---------------------------------------------------------------------- */

async function parseDOCX(arrayBuffer) {
  let result;
  try {
    result = await mammoth.convertToHtml({ arrayBuffer });
  } catch (err) {
    throw new FileParseError(
      "corrupt",
      "StudyLens couldn't read this file. Please make sure the file isn't corrupted or password-protected."
    );
  }

  const doc = new DOMParser().parseFromString(result.value, "text/html");
  const text = structuredTextFromHtml(doc.body);
  return { text: cleanWhitespaceFP(text) };
}

// Shared by DOCX (mammoth's HTML output). Mirrors content.js's approach so
// headings, lists, and tables come out in the same style everywhere in
// StudyLens.
function structuredTextFromHtml(container) {
  const lines = [];

  function addLine(line) {
    const clean = cleanWhitespaceFP(line);
    if (clean) lines.push(clean);
  }

  function walk(node) {
    if (node.nodeType !== 1) return;
    const tag = node.tagName;

    if (/^H[1-6]$/.test(tag)) {
      addLine("\n" + node.textContent.toUpperCase());
      return;
    }
    if (tag === "P") {
      addLine(node.textContent);
      return;
    }
    if (tag === "UL" || tag === "OL") {
      Array.from(node.children).forEach((li) => {
        if (li.tagName === "LI") addLine("• " + li.textContent);
      });
      return;
    }
    if (tag === "TABLE") {
      Array.from(node.querySelectorAll("tr")).forEach((row) => {
        const cells = Array.from(row.querySelectorAll("th, td")).map((c) => c.textContent.trim());
        if (cells.some((c) => c)) addLine(cells.join(" | "));
      });
      return;
    }
    Array.from(node.children).forEach(walk);
  }

  Array.from(container.children).forEach(walk);
  return lines.join("\n\n");
}

/* ---------------------------------------------------------------------- *
 *  PPTX (via JSZip - PowerPoint files are a zip of slide XML files)
 * ---------------------------------------------------------------------- */

async function parsePPTX(arrayBuffer, onProgress) {
  let zip;
  try {
    zip = await JSZip.loadAsync(arrayBuffer);
  } catch (err) {
    throw new FileParseError(
      "corrupt",
      "StudyLens couldn't read this file. Please make sure the file isn't corrupted or password-protected."
    );
  }

  const slideFiles = Object.keys(zip.files)
    .filter((name) => /^ppt\/slides\/slide\d+\.xml$/.test(name))
    .sort((a, b) => {
      const na = parseInt(a.match(/slide(\d+)\.xml/)[1], 10);
      const nb = parseInt(b.match(/slide(\d+)\.xml/)[1], 10);
      return na - nb;
    });

  if (slideFiles.length === 0) {
    throw new FileParseError("corrupt", "StudyLens couldn't find any slides in this file.");
  }

  const parser = new DOMParser();
  const slideBlocks = [];

  for (let i = 0; i < slideFiles.length; i++) {
    if (onProgress) onProgress("Extracting slide " + (i + 1) + " of " + slideFiles.length + "…");

    const xmlText = await zip.files[slideFiles[i]].async("string");
    const xmlDoc = parser.parseFromString(xmlText, "application/xml");
    const slideText = Array.from(xmlDoc.getElementsByTagName("a:t"))
      .map((node) => node.textContent)
      .join(" ")
      .trim();

    const slideNumber = slideFiles[i].match(/slide(\d+)\.xml/)[1];
    const notesPath = "ppt/notesSlides/notesSlide" + slideNumber + ".xml";
    let notesText = "";
    if (zip.files[notesPath]) {
      const notesXmlText = await zip.files[notesPath].async("string");
      const notesDoc = parser.parseFromString(notesXmlText, "application/xml");
      notesText = Array.from(notesDoc.getElementsByTagName("a:t"))
        .map((node) => node.textContent)
        .join(" ")
        .trim();
    }

    let block = "SLIDE " + (i + 1) + "\n" + (slideText || "(no readable text on this slide)");
    if (notesText) block += "\nSpeaker notes: " + notesText;
    slideBlocks.push(block);
  }

  return { text: cleanWhitespaceFP(slideBlocks.join("\n\n")), slideCount: slideFiles.length };
}

/* ---------------------------------------------------------------------- *
 *  TXT / Markdown / CSV / RTF (no external library needed)
 * ---------------------------------------------------------------------- */

async function parseTXT(file) {
  const text = await file.text();
  return { text: cleanWhitespaceFP(text) };
}

function parseMarkdown(rawText) {
  let text = rawText.replace(/\r\n/g, "\n");
  text = text.replace(/^#{1,6}\s+(.*)$/gm, (match, heading) => "\n" + heading.trim().toUpperCase());
  text = text.replace(/^[-*+]\s+(.*)$/gm, "• $1");
  text = text.replace(/```[\s\S]*?```/g, (block) => block.replace(/```/g, ""));
  text = text.replace(/\*\*(.*?)\*\*/g, "$1");
  text = text.replace(/(^|\W)\*(?!\s)(.*?)\*(?=\W|$)/g, "$1$2");
  text = text.replace(/`([^`]*)`/g, "$1");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
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
    lines.push(
      "\n(StudyLens only read the first " + CSV_MAX_ROWS + " of " + dataRows.length + " rows in this file.)"
    );
  }

  return { text: cleanWhitespaceFP(lines.join("\n")), rowCount: dataRows.length, truncated };
}

// RTF has no vendored parser (see README > Limitations) - this is a small,
// best-effort control-word stripper rather than a full RTF implementation.
function parseRTF(rawText) {
  let text = rawText;
  text = text.replace(/\\'([0-9a-fA-F]{2})/g, (match, hex) => String.fromCharCode(parseInt(hex, 16)));
  text = text.replace(/\{\\\*[^{}]*\}/g, "");
  text = text.replace(/\\par[d]?/g, "\n");
  text = text.replace(/\\tab/g, "\t");
  text = text.replace(/\\[a-zA-Z]+-?\d* ?/g, "");
  text = text.replace(/[{}]/g, "");
  return { text: cleanWhitespaceFP(text), bestEffort: true };
}

/* ---------------------------------------------------------------------- *
 *  Dispatcher
 * ---------------------------------------------------------------------- */

async function extractFileContent(file, onProgress) {
  const ext = extensionOf(file.name);
  const kind = ext === "markdown" ? "md" : ext;

  if (!FILE_SUPPORT.extensions.includes(ext)) {
    throw new FileParseError("unsupported", "Please upload a supported document such as PDF, DOCX, PPTX, or TXT.");
  }
  if (file.size > FILE_SUPPORT.maxSizeBytes) {
    throw new FileParseError("too-large", "File is too large. Please upload a file smaller than " + FILE_SUPPORT.maxSizeLabel + ".");
  }

  if (onProgress) onProgress("Uploading…");

  let result;
  if (kind === "pdf") {
    if (onProgress) onProgress("Reading PDF…");
    result = await parsePDF(await file.arrayBuffer(), onProgress);
  } else if (kind === "docx") {
    if (onProgress) onProgress("Reading Word document…");
    result = await parseDOCX(await file.arrayBuffer());
  } else if (kind === "pptx") {
    if (onProgress) onProgress("Extracting PowerPoint text…");
    result = await parsePPTX(await file.arrayBuffer(), onProgress);
  } else if (kind === "txt") {
    if (onProgress) onProgress("Reading document structure…");
    result = await parseTXT(file);
  } else if (kind === "md") {
    if (onProgress) onProgress("Reading document structure…");
    result = parseMarkdown(await file.text());
  } else if (kind === "csv") {
    if (onProgress) onProgress("Reading spreadsheet rows…");
    result = parseCSV(await file.text());
  } else if (kind === "rtf") {
    if (onProgress) onProgress("Reading document structure…");
    result = parseRTF(await file.text());
  } else {
    throw new FileParseError("unsupported", "Please upload a supported document such as PDF, DOCX, PPTX, or TXT.");
  }

  if (onProgress) onProgress("Analyzing important information…");
  const wordCount = countWordsFP(result.text);

  if (wordCount < MIN_WORD_COUNT) {
    if (kind === "pdf" && result.scanned) {
      throw new FileParseError(
        "scanned",
        "This PDF appears to contain scanned images rather than selectable text. OCR isn't available in this " +
          "version of StudyLens - try uploading a text-based PDF or another supported document."
      );
    }
    throw new FileParseError(
      "empty",
      "StudyLens couldn't find readable text in this file. Try uploading a text-based PDF or another supported document."
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
