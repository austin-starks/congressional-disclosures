/**
 * Deterministic row labels, R1..RN, on every non-blank OCR line in page and line order,
 * as a leading table cell or a "[Rn] " prefix. Lines are told apart by markdown grammar
 * alone, never by content. Every line is labeled, not only table rows, because OCR does
 * not preserve table shape; `ptrRowCoverage` proves each label was accounted for.
 */
const TABLE_SEPARATOR = /^\|\s*:?-{3,}/;

export interface NumberedOcrFiling {
  /** The filing's OCR pages with row labels added. */
  pages: string[];
  /** Page (1-based) of each labeled row: `rowPages[n - 1]` is the page of Rn. */
  rowPages: number[];
  /** Line (0-based) of each labeled row within its page. */
  rowLines: number[];
  /** Whether each labeled row is a markdown table line: `tableRows[n - 1]` is Rn's. */
  tableRows: boolean[];
}

export function ocrRowLabel(row: number): string {
  return `R${row}`;
}

export function numberOcrRows(pages: readonly string[]): NumberedOcrFiling {
  const rowPages: number[] = [];
  const rowLines: number[] = [];
  const tableRows: boolean[] = [];
  const numbered = pages.map((markdown, pageIndex) =>
    markdown
      .split("\n")
      .map((line, lineIndex) => {
        if (line.trim() === "") return line;
        const table = line.startsWith("|");
        if (table && TABLE_SEPARATOR.test(line)) return `| --- ${line}`;
        rowPages.push(pageIndex + 1);
        rowLines.push(lineIndex);
        tableRows.push(table);
        const label = ocrRowLabel(rowPages.length);
        return table ? `| ${label} ${line}` : `[${label}] ${line}`;
      })
      .join("\n")
  );
  return { pages: numbered, rowPages, rowLines, tableRows };
}
