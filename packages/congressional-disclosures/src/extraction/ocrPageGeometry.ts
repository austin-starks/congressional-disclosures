/**
 * Where a page's table sits, from the OCR response the page was read with (Mistral OCR `blocks`).
 *
 * A reconciling read is shown the filed page cropped to the rows it is settling
 * (`planReconcileAttachment` in `ocrTextPlan.ts`). At whole-page framing a model reads a form's narrow checkbox
 * columns one column off: on Blumenthal 2022 `accadeb3` page 2 the same model and page gave every row's amount one
 * column right of where it is printed, and read all ten rows correctly from a crop that fills the frame with the
 * table (2026-09-15). Every OCR response already carries the table's box, so the crop costs nothing to compute.
 */
export interface OcrPageBox {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

export interface OcrPageGeometry {
  /** The page's size in the OCR response's own pixels; a crop scales from these to the image it cuts. */
  width: number;
  height: number;
  /** The largest table block the read found, or null when it found none. */
  table: OcrPageBox | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boxOf(block: Record<string, unknown>): OcrPageBox | null {
  const { top_left_x: left, top_left_y: top, bottom_right_x: right, bottom_right_y: bottom } = block;
  if (
    typeof left !== "number" ||
    typeof top !== "number" ||
    typeof right !== "number" ||
    typeof bottom !== "number" ||
    right <= left ||
    bottom <= top
  ) {
    return null;
  }
  return { left, top, right, bottom };
}

/** The geometry of the first page of a verbatim OCR response, or null when it carries none. */
export function ocrPageGeometry(payload: Record<string, unknown>): OcrPageGeometry | null {
  const pages = Array.isArray(payload.pages) ? payload.pages.filter(isRecord) : [];
  const page = pages[0];
  if (!page) return null;
  const dimensions = isRecord(page.dimensions) ? page.dimensions : null;
  if (!dimensions || typeof dimensions.width !== "number" || typeof dimensions.height !== "number") return null;
  const tables = (Array.isArray(page.blocks) ? page.blocks.filter(isRecord) : [])
    .filter((block) => block.type === "table")
    .flatMap((block) => {
      const box = boxOf(block);
      return box ? [box] : [];
    })
    .sort((left, right) => area(right) - area(left));
  return { width: dimensions.width, height: dimensions.height, table: tables[0] ?? null };
}

function area(box: OcrPageBox): number {
  return (box.right - box.left) * (box.bottom - box.top);
}
