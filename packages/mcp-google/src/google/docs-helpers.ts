// Helpers for walking Google Docs body content + building batchUpdate requests.

import type { docs_v1 } from "googleapis";

/**
 * Extract plain text from a Google Doc by walking body.content[] and
 * concatenating textRun.content across all paragraph elements.
 * Tables are rendered cell-by-cell with tab separators per row.
 */
export function extractPlainText(doc: docs_v1.Schema$Document): string {
  const body = doc.body;
  if (!body?.content) return "";
  return body.content.map(renderStructuralElement).join("");
}

function renderStructuralElement(el: docs_v1.Schema$StructuralElement): string {
  if (el.paragraph) {
    return renderParagraph(el.paragraph);
  }
  if (el.table) {
    return renderTable(el.table);
  }
  if (el.sectionBreak) {
    return "\n";
  }
  if (el.tableOfContents) {
    return (el.tableOfContents.content ?? []).map(renderStructuralElement).join("");
  }
  return "";
}

function renderParagraph(p: docs_v1.Schema$Paragraph): string {
  const elements = p.elements ?? [];
  let out = "";
  for (const el of elements) {
    if (el.textRun?.content) {
      out += el.textRun.content;
    }
    // Ignore footnoteReference, personLink, etc. for plain text
  }
  return out;
}

function renderTable(t: docs_v1.Schema$Table): string {
  const rows = t.tableRows ?? [];
  return rows
    .map((row) => {
      const cells = row.tableCells ?? [];
      return cells
        .map((cell) => (cell.content ?? []).map(renderStructuralElement).join("").trim())
        .join("\t");
    })
    .join("\n") + "\n";
}

/**
 * Determine the index just before the final newline in the body.
 * Google Docs bodies always end with a synthetic newline at the last element's endIndex;
 * the valid insertion range is [1, endIndex - 1].
 */
export function getDocEndIndex(doc: docs_v1.Schema$Document): number {
  const body = doc.body;
  if (!body?.content || body.content.length === 0) return 1;
  const last = body.content[body.content.length - 1];
  const end = last.endIndex ?? 1;
  return Math.max(1, end - 1);
}

export function buildInsertTextRequests(
  text: string,
  index: number,
): docs_v1.Schema$Request[] {
  return [
    {
      insertText: {
        location: { index },
        text,
      },
    },
  ];
}

export function buildReplaceAllRequests(
  doc: docs_v1.Schema$Document,
  newText: string,
): docs_v1.Schema$Request[] {
  const end = getDocEndIndex(doc);
  const requests: docs_v1.Schema$Request[] = [];
  if (end > 1) {
    requests.push({
      deleteContentRange: {
        range: { startIndex: 1, endIndex: end },
      },
    });
  }
  requests.push({
    insertText: {
      location: { index: 1 },
      text: newText,
    },
  });
  return requests;
}
