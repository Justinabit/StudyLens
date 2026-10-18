/*
  markdown.js
  -----------
  A small, safe Markdown renderer for AI results. AI output is untrusted:
  every line is HTML-escaped FIRST, and only a fixed set of tags is ever
  produced (headings, paragraphs, lists, tables, code, emphasis), so text
  from the model - or from a webpage it quoted - can never inject markup
  or scripts into the side panel.

  Supports what StudyLens's prompts ask for: # headings, - / 1. lists
  (nested by indentation), **bold**, *italic*, `code`, ``` fences, > quotes,
  | tables |, and --- rules. Single line breaks are kept, since AI output
  often relies on them (e.g. one "**Term** — definition" per line).
*/

const Markdown = (() => {
  const ESCAPES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };

  function escapeHtml(text) {
    return String(text).replace(/[&<>"']/g, (c) => ESCAPES[c]);
  }

  // Input must already be escaped.
  function inline(text) {
    const codes = [];
    let s = text.replace(/`([^`]+)`/g, (m, code) => {
      codes.push(code);
      return "\u0000" + (codes.length - 1) + "\u0000";
    });
    s = s.replace(/\*\*(?=\S)(.+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__(?=\S)(.+?)__/g, "<strong>$1</strong>");
    s = s.replace(/(^|[^*\w])\*(?=\S)([^*]+?)\*(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/(^|[^_\w])_(?=\S)([^_]+?)_(?!\w)/g, "$1<em>$2</em>");
    s = s.replace(/==(?=\S)(.+?)==/g, "<mark>$1</mark>");
    return s.replace(/\u0000(\d+)\u0000/g, (m, i) => "<code>" + codes[Number(i)] + "</code>");
  }

  const LIST_ITEM = /^(\s*)([-*+•]|\d{1,3}[.)])\s+(.*)$/;
  const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;
  const RULE = /^\s*([-*_])(\s*\1){2,}\s*$/;
  const TABLE_DIVIDER = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function splitRow(line) {
    return line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());
  }

  function render(markdown, options) {
    const opts = options || {};
    const lines = String(markdown || "").replace(/\r\n?/g, "\n").split("\n");
    const out = [];
    const listStack = []; // { type: "ul" | "ol", indent }
    let paragraph = [];
    let headingCount = 0;

    const flushParagraph = () => {
      if (paragraph.length) {
        out.push("<p>" + paragraph.map((l) => inline(escapeHtml(l))).join("<br>") + "</p>");
        paragraph = [];
      }
    };
    const closeLists = (toIndent) => {
      while (listStack.length && listStack[listStack.length - 1].indent > toIndent) {
        out.push("</li></" + listStack.pop().type + ">");
      }
    };
    const closeAll = () => {
      flushParagraph();
      closeLists(-1);
    };

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];

      // Fenced code block
      if (/^\s*```/.test(line)) {
        closeAll();
        const code = [];
        i++;
        while (i < lines.length && !/^\s*```/.test(lines[i])) code.push(lines[i++]);
        out.push("<pre><code>" + escapeHtml(code.join("\n")) + "</code></pre>");
        continue;
      }

      if (!line.trim()) {
        flushParagraph();
        // A blank line ends a list unless the next line continues it.
        const next = lines.slice(i + 1).find((l) => l.trim());
        if (listStack.length && !(next && (LIST_ITEM.test(next) || /^\s{2,}\S/.test(next)))) closeLists(-1);
        continue;
      }

      const heading = line.match(HEADING);
      if (heading) {
        closeAll();
        const level = heading[1].length;
        const id = opts.headingIds ? ' id="' + opts.headingIds + "-" + headingCount++ + '"' : "";
        out.push("<h" + level + id + ">" + inline(escapeHtml(heading[2])) + "</h" + level + ">");
        continue;
      }

      if (RULE.test(line)) {
        closeAll();
        out.push("<hr>");
        continue;
      }

      if (/^\s*>/.test(line)) {
        closeAll();
        const quoted = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ""));
        i--;
        out.push("<blockquote>" + render(quoted.join("\n")) + "</blockquote>");
        continue;
      }

      if (line.includes("|") && i + 1 < lines.length && TABLE_DIVIDER.test(lines[i + 1])) {
        closeAll();
        const header = splitRow(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) rows.push(splitRow(lines[i++]));
        i--;
        out.push(
          '<div class="md-table-wrap"><table><thead><tr>' +
            header.map((c) => "<th>" + inline(escapeHtml(c)) + "</th>").join("") +
            "</tr></thead><tbody>" +
            rows.map((r) => "<tr>" + r.map((c) => "<td>" + inline(escapeHtml(c)) + "</td>").join("") + "</tr>").join("") +
            "</tbody></table></div>"
        );
        continue;
      }

      const item = line.match(LIST_ITEM);
      if (item) {
        flushParagraph();
        const indent = item[1].replace(/\t/g, "    ").length;
        const type = /\d/.test(item[2]) ? "ol" : "ul";
        const top = listStack[listStack.length - 1];

        if (!top || indent > top.indent + 1) {
          const start = type === "ol" && parseInt(item[2], 10) !== 1 ? ' start="' + parseInt(item[2], 10) + '"' : "";
          out.push("<" + type + start + "><li>");
          listStack.push({ type, indent });
        } else {
          closeLists(indent);
          const current = listStack[listStack.length - 1];
          if (current && current.type !== type && current.indent <= indent) {
            out.push("</li></" + listStack.pop().type + ">");
            out.push("<" + type + "><li>");
            listStack.push({ type, indent });
          } else if (current) {
            out.push("</li><li>");
          } else {
            out.push("<" + type + "><li>");
            listStack.push({ type, indent });
          }
        }
        out.push(inline(escapeHtml(item[3])));
        continue;
      }

      if (listStack.length && /^\s+\S/.test(line)) {
        // Indented continuation of the current list item.
        out.push("<br>" + inline(escapeHtml(line.trim())));
        continue;
      }

      closeLists(-1);
      paragraph.push(line.trim());
    }

    closeAll();
    return out.join("");
  }

  // Plain text for places that can't show formatting (e.g. file names).
  function toPlainText(markdown) {
    return String(markdown || "")
      .replace(/^#{1,6}\s+/gm, "")
      .replace(/\*\*(.+?)\*\*/g, "$1")
      .replace(/__(.+?)__/g, "$1")
      .replace(/`([^`]+)`/g, "$1");
  }

  // Bold/italic/code only - for short strings like quiz options.
  function renderInline(text) {
    return inline(escapeHtml(String(text || "")));
  }

  return { render, renderInline, escapeHtml, toPlainText };
})();
