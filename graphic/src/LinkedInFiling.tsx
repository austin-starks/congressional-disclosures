import React from "react";
import {
  AbsoluteFill,
  Easing,
  Img,
  interpolate,
  spring,
  staticFile,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { theme } from "./theme";

/**
 * Rep. Mike Kelly's handwritten December 2015 PTR (House doc 9108156) next to the rows the
 * published dataset returns for it. Both pages are the Clerk's scan at 200 dpi, rotated
 * upright; every box below is in those pixels, measured from the form's ruled lines.
 */
const PAGE_WIDTH = 2200;
const PAGE_HEIGHT = 1696;

const CANVAS_PADDING = 44;
const CONTENT_TOP = 168;
const CONTENT_BOTTOM = 1284;
const PANE_WIDTH = 1080 - CANVAS_PADDING * 2;
/** The caption sits between the scan and the terminal, so it never covers a handwritten row. */
const CAPTION_ROW = 64;
const CAPTION_HEIGHT = 46;
const SCAN_PANE_HEIGHT = 548;
const FULL_PANE_HEIGHT = CONTENT_BOTTOM - CONTENT_TOP;
const SIDEWAYS_SCALE = Math.min(PANE_WIDTH / PAGE_HEIGHT, FULL_PANE_HEIGHT / PAGE_WIDTH);
const TABLE_SCALE = PANE_WIDTH / 1150;

const MARKER = "#ffd33d";
const EASE = Easing.bezier(0.16, 1, 0.3, 1);

interface PageGrid {
  src: string;
  /** Left edge, then the right edge of owner, asset, purchase, sale, exchange, date, notified, amount A. */
  columns: readonly number[];
  /** Top edge of each handwritten row, then the bottom of the last. */
  rows: readonly number[];
  /** Page point the camera centers on once the table is in view. */
  view: { x: number; y: number };
}

const PAGES: readonly PageGrid[] = [
  {
    src: "kelly-9108156-p1.png",
    columns: [165, 226, 717, 784, 850, 915, 1045, 1196, 1278],
    rows: [1215, 1293, 1371, 1448, 1528],
    view: { x: 725, y: 1220 },
  },
  {
    src: "kelly-9108156-p2.png",
    columns: [159, 220, 712, 778, 844, 910, 1040, 1190, 1270],
    rows: [657, 740, 823, 905],
    view: { x: 719, y: 642 },
  },
];

type ScanField = "asset" | "purchase" | "sale" | "date" | "amount";

const FIELD_COLUMNS: Record<ScanField, [number, number]> = {
  asset: [1, 2],
  purchase: [2, 3],
  sale: [3, 4],
  date: [5, 6],
  amount: [7, 8],
};

type ResultColumn = "date" | "action" | "asset" | "ticker" | "amount";

/** Column widths in characters, as `sqlite3 -header -column` prints them. */
const RESULT_COLUMNS: readonly { key: ResultColumn; width: number }[] = [
  { key: "date", width: 10 },
  { key: "action", width: 8 },
  { key: "asset", width: 23 },
  { key: "ticker", width: 6 },
  { key: "amount", width: 16 },
];

interface ResultRow extends Record<ResultColumn, string> {
  page: number;
  slot: number;
}

/** Verbatim output of QUERY against the 2026-09-20 snapshot, in the form's row order. */
const RESULT_ROWS: readonly ResultRow[] = [
  { date: "2015-12-18", action: "purchase", asset: "LAM RESEARCH CORP STK", ticker: "LRCX", amount: "$1,001 - $15,000", page: 0, slot: 0 },
  { date: "2015-12-18", action: "purchase", asset: "MICROSOFT CORP STK", ticker: "MSFT", amount: "$1,001 - $15,000", page: 0, slot: 1 },
  { date: "2015-12-16", action: "purchase", asset: "O'REILLY AUTOMOTIVE INC", ticker: "ORLY", amount: "$1,001 - $15,000", page: 0, slot: 2 },
  { date: "2015-12-18", action: "purchase", asset: "TEXAS INSTRUMENTS INC", ticker: "TXN", amount: "$1,001 - $15,000", page: 0, slot: 3 },
  { date: "2015-12-16", action: "purchase", asset: "WYNDHAM WORLDWIDE", ticker: "WYN", amount: "$1,001 - $15,000", page: 1, slot: 0 },
  { date: "2015-12-17", action: "sale", asset: "SIGNET JEWELERS LTD", ticker: "SIG", amount: "$1,001 - $15,000", page: 1, slot: 1 },
  { date: "2015-12-18", action: "sale", asset: "GOLDMAN SACHS GROUP", ticker: "GS", amount: "$1,001 - $15,000", page: 1, slot: 2 },
];

const COMMAND = "npx congressional-disclosures@latest download --sqlite";

const QUERY_LINES = [
  "SELECT transaction_date AS date, action,",
  "       asset_description AS asset, resolved_ticker AS ticker,",
  "       amount_bracket AS amount",
  "FROM political_trades WHERE doc_id = '9108156'",
  "ORDER BY row_index;",
];

/** The one row walked field by field: the handwritten Microsoft purchase. */
const HERO_ROW = 1;
const HERO_FIELDS: readonly { scan: ScanField; cells: readonly ResultColumn[]; caption: string }[] = [
  { scan: "asset", cells: ["asset", "ticker"], caption: "“MICROSOFT CORP STK” in pen → MSFT" },
  { scan: "purchase", cells: ["action"], caption: "X under Purchase → purchase" },
  { scan: "date", cells: ["date"], caption: "12/18/15 → 2015-12-18" },
  { scan: "amount", cells: ["amount"], caption: "X in column A → $1,001 - $15,000" },
];

const T = {
  rotate: [58, 98] as const,
  command: 100,
  checks: [132, 146] as const,
  query: 160,
  queryCharsPerFrame: 4,
  header: 212,
  rowStarts: [222, 236, 250, 264, 432, 446, 460],
  heroStart: 290,
  heroFieldFrames: 30,
  flip: [410, 428] as const,
  finale: 486,
};

export const LINKEDIN_FILING_FRAMES = 560;

const clamp = { extrapolateLeft: "clamp", extrapolateRight: "clamp" } as const;

function heroFieldAt(frame: number): number | null {
  const index = Math.floor((frame - T.heroStart) / T.heroFieldFrames);
  return index >= 0 && index < HERO_FIELDS.length ? index : null;
}

function fieldBox(page: PageGrid, slot: number, field: ScanField): React.CSSProperties {
  const [from, to] = FIELD_COLUMNS[field];
  return {
    left: page.columns[from],
    top: page.rows[slot],
    width: page.columns[to] - page.columns[from],
    height: page.rows[slot + 1] - page.rows[slot],
  };
}

function rowBox(page: PageGrid, slot: number): React.CSSProperties {
  return {
    left: page.columns[0],
    top: page.rows[slot],
    width: page.columns[page.columns.length - 1] - page.columns[0],
    height: page.rows[slot + 1] - page.rows[slot],
  };
}

const ScanPage: React.FC<{
  page: PageGrid;
  pageIndex: number;
  frame: number;
  opacity: number;
  rotation: number;
  scale: number;
  focus: { x: number; y: number };
  paneHeight: number;
}> = ({ page, pageIndex, frame, opacity, rotation, scale, focus, paneHeight }) => {
  const heroField = heroFieldAt(frame);
  return (
    <div
      style={{
        position: "absolute",
        left: 0,
        top: 0,
        width: PAGE_WIDTH,
        height: PAGE_HEIGHT,
        opacity,
        transformOrigin: "0 0",
        transform: `translate(${PANE_WIDTH / 2}px, ${paneHeight / 2}px) rotate(${rotation}deg) scale(${scale}) translate(${-focus.x}px, ${-focus.y}px)`,
      }}
    >
      <Img src={staticFile(page.src)} style={{ width: PAGE_WIDTH, height: PAGE_HEIGHT, display: "block" }} />
      {RESULT_ROWS.map((row, index) => {
        if (row.page !== pageIndex) return null;
        const landed = interpolate(frame, [T.rowStarts[index], T.rowStarts[index] + 8], [0, 1], clamp);
        const glow = interpolate(frame, [T.rowStarts[index], T.rowStarts[index] + 6, T.rowStarts[index] + 22], [0, 1, 0.35], clamp);
        return (
          <div
            key={row.ticker}
            style={{
              position: "absolute",
              ...rowBox(page, row.slot),
              border: `7px solid ${theme.accent}`,
              borderRadius: 10,
              background: `rgba(88,166,255,${0.16 * glow})`,
              opacity: landed,
            }}
          />
        );
      })}
      {pageIndex === RESULT_ROWS[HERO_ROW].page && heroField !== null ? (
        <div
          style={{
            position: "absolute",
            ...fieldBox(page, RESULT_ROWS[HERO_ROW].slot, HERO_FIELDS[heroField].scan),
            border: `8px solid ${MARKER}`,
            borderRadius: 10,
            background: "rgba(255,211,61,.32)",
            opacity: interpolate(frame - T.heroStart - heroField * T.heroFieldFrames, [0, 6], [0, 1], clamp),
          }}
        />
      ) : null}
    </div>
  );
};

function cellText(value: string, width: number): string {
  return value.padEnd(width, " ");
}

const ResultTable: React.FC<{ frame: number; fps: number }> = ({ frame, fps }) => {
  const headerIn = interpolate(frame, [T.header, T.header + 8], [0, 1], clamp);
  const heroField = heroFieldAt(frame);
  const cellStyle = (width: number): React.CSSProperties => ({
    display: "inline-block",
    width: `${width + 2}ch`,
    whiteSpace: "pre",
    borderRadius: 4,
  });

  return (
    <div style={{ marginTop: 10 }}>
      <div style={{ color: theme.muted, opacity: headerIn }}>
        {RESULT_COLUMNS.map((column) => (
          <span key={column.key} style={cellStyle(column.width)}>
            {cellText(column.key, column.width)}
          </span>
        ))}
      </div>
      {RESULT_ROWS.map((row, index) => {
        const start = T.rowStarts[index];
        const landed = spring({ frame: frame - start, fps, config: { damping: 200 } });
        const glow = interpolate(frame, [start, start + 6, start + 22], [0, 1, 0.3], clamp);
        const dimmed = row.page === 0 ? interpolate(frame, [T.flip[0], T.flip[1]], [1, 0.55], clamp) : 1;
        const onHero = index === HERO_ROW && heroField !== null;
        return (
          <div
            key={row.ticker}
            style={{
              opacity: landed * dimmed,
              transform: `translateY(${interpolate(landed, [0, 1], [8, 0])}px)`,
              background: `rgba(88,166,255,${0.2 * glow})`,
              borderLeft: `4px solid rgba(88,166,255,${Math.max(glow, onHero ? 1 : 0)})`,
              marginLeft: -12,
              paddingLeft: 8,
            }}
          >
            {RESULT_COLUMNS.map((column) => {
              const marked = onHero && heroField !== null && HERO_FIELDS[heroField].cells.includes(column.key);
              return (
                <span
                  key={column.key}
                  style={{
                    ...cellStyle(column.width),
                    color: marked ? MARKER : theme.text,
                    background: marked ? "rgba(255,211,61,.16)" : "transparent",
                    fontWeight: marked ? 700 : 400,
                  }}
                >
                  {cellText(row[column.key], column.width)}
                </span>
              );
            })}
          </div>
        );
      })}
    </div>
  );
};

function typedQuery(frame: number): string[] {
  const total = Math.max(0, Math.floor((frame - T.query) * T.queryCharsPerFrame));
  const lines: string[] = [];
  let remaining = total;
  for (const line of QUERY_LINES) {
    if (remaining <= 0) break;
    lines.push(line.slice(0, remaining));
    remaining -= line.length;
  }
  return lines;
}

function captionAt(frame: number): string {
  const heroField = heroFieldAt(frame);
  if (heroField !== null) return HERO_FIELDS[heroField].caption;
  if (frame < T.rotate[1]) return "As filed: handwritten, hand delivered, scanned sideways";
  if (frame >= T.finale) return "7 handwritten trades → 7 rows";
  if (frame >= T.flip[0]) return "Page 2 of 2";
  return "House filing 9108156, page 1 of 2";
}

export const LinkedInFiling: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const turn = interpolate(frame, [T.rotate[0], T.rotate[1]], [0, 1], { ...clamp, easing: EASE });
  const firstPage = PAGES[0];
  const paneHeight = interpolate(turn, [0, 1], [FULL_PANE_HEIGHT, SCAN_PANE_HEIGHT]);
  const flip = interpolate(frame, [T.flip[0], T.flip[1]], [0, 1], { ...clamp, easing: EASE });
  const titleIn = spring({ frame, fps, config: { damping: 200 } });
  const terminalIn = interpolate(frame, [T.rotate[1] - 16, T.rotate[1] + 4], [0, 1], { ...clamp, easing: EASE });
  const command = COMMAND.slice(0, Math.max(0, Math.floor((frame - T.command) * 2.2)));
  const checkOne = spring({ frame: frame - T.checks[0], fps, config: { damping: 200 } });
  const checkTwo = spring({ frame: frame - T.checks[1], fps, config: { damping: 200 } });
  const query = typedQuery(frame);
  const cursorOn = Math.floor(frame / 12) % 2 === 0;
  const caption = captionAt(frame);
  const heroField = heroFieldAt(frame);
  const isHero = heroField !== null;
  const captionIn = isHero
    ? interpolate(frame - T.heroStart - heroField * T.heroFieldFrames, [0, 6], [0.4, 1], clamp)
    : 1;
  const finale = interpolate(frame, [T.finale, T.finale + 14], [0, 1], clamp);

  return (
    <AbsoluteFill style={{ background: "#080b10", color: theme.text, fontFamily: theme.sans }}>
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 85% 6%, rgba(88,166,255,.16), transparent 36%), linear-gradient(160deg, rgba(63,185,80,.05), transparent 50%)",
        }}
      />

      <header
        style={{
          position: "absolute",
          left: CANVAS_PADDING,
          right: CANVAS_PADDING,
          top: 40,
          opacity: titleIn,
          transform: `translateY(${interpolate(titleIn, [0, 1], [12, 0])}px)`,
        }}
      >
        <div
          style={{
            color: theme.accent,
            fontFamily: theme.mono,
            fontSize: 20,
            fontWeight: 700,
            letterSpacing: 2.2,
            textTransform: "uppercase",
          }}
        >
          congressional-disclosures
        </div>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginTop: 10 }}>
          <div style={{ fontSize: 46, fontWeight: 760, letterSpacing: -1.4 }}>Filed by hand. Queried with SQL.</div>
          <div style={{ color: theme.muted, fontFamily: theme.mono, fontSize: 19 }}>Rep. Mike Kelly</div>
        </div>
      </header>

      <div
        style={{
          position: "absolute",
          left: CANVAS_PADDING,
          top: CONTENT_TOP,
          width: PANE_WIDTH,
          height: paneHeight,
          borderRadius: 16,
          overflow: "hidden",
          background: "#11161d",
          border: `1px solid ${theme.border}`,
          boxShadow: "0 28px 80px rgba(0,0,0,.45)",
        }}
      >
        <ScanPage
          page={firstPage}
          pageIndex={0}
          frame={frame}
          opacity={1 - flip}
          rotation={interpolate(turn, [0, 1], [90, 0])}
          scale={interpolate(turn, [0, 1], [SIDEWAYS_SCALE, TABLE_SCALE])}
          focus={{
            x: interpolate(turn, [0, 1], [PAGE_WIDTH / 2, firstPage.view.x]),
            y: interpolate(turn, [0, 1], [PAGE_HEIGHT / 2, firstPage.view.y]),
          }}
          paneHeight={paneHeight}
        />
        <ScanPage
          page={PAGES[1]}
          pageIndex={1}
          frame={frame}
          opacity={flip}
          rotation={0}
          scale={TABLE_SCALE}
          focus={{ x: PAGES[1].view.x, y: PAGES[1].view.y + interpolate(flip, [0, 1], [40, 0]) }}
          paneHeight={paneHeight}
        />

      </div>

      <div
        style={{
          position: "absolute",
          left: CANVAS_PADDING + PANE_WIDTH / 2,
          top: interpolate(
            turn,
            [0, 1],
            [CONTENT_TOP + FULL_PANE_HEIGHT - CAPTION_HEIGHT - 20, CONTENT_TOP + SCAN_PANE_HEIGHT + (CAPTION_ROW - CAPTION_HEIGHT) / 2],
          ),
          height: CAPTION_HEIGHT,
          display: "flex",
          alignItems: "center",
          transform: "translateX(-50%)",
          padding: "0 20px",
          borderRadius: 999,
          background: "rgba(8,11,16,.9)",
          border: `1px solid ${isHero ? MARKER : theme.border}`,
          color: isHero ? MARKER : frame >= T.finale ? theme.ok : theme.text,
          fontFamily: theme.mono,
          fontSize: 22,
          fontWeight: 650,
          whiteSpace: "nowrap",
          opacity: captionIn,
        }}
      >
        {caption}
      </div>

      <div
        style={{
          position: "absolute",
          left: CANVAS_PADDING,
          top: CONTENT_TOP + SCAN_PANE_HEIGHT + CAPTION_ROW,
          width: PANE_WIDTH,
          height: CONTENT_BOTTOM - CONTENT_TOP - SCAN_PANE_HEIGHT - CAPTION_ROW,
          borderRadius: 16,
          overflow: "hidden",
          border: `1px solid ${theme.border}`,
          background: "rgba(13,17,23,.97)",
          boxShadow: "0 28px 80px rgba(0,0,0,.42)",
          opacity: terminalIn,
          transform: `translateY(${interpolate(terminalIn, [0, 1], [40, 0])}px)`,
        }}
      >
        <div
          style={{
            height: 40,
            borderBottom: `1px solid ${theme.border}`,
            display: "flex",
            alignItems: "center",
            gap: 9,
            padding: "0 18px",
            background: theme.panel,
          }}
        >
          {["#ff5f57", "#febc2e", "#28c840"].map((color) => (
            <div key={color} style={{ width: 12, height: 12, borderRadius: 999, background: color }} />
          ))}
          <div style={{ marginLeft: 12, fontFamily: theme.mono, color: theme.muted, fontSize: 15 }}>
            ~/congressional-stock-trades
          </div>
        </div>

        <div style={{ padding: "14px 28px", fontFamily: theme.mono, fontSize: 19, lineHeight: 1.4, letterSpacing: -0.3 }}>
          <div style={{ whiteSpace: "pre" }}>
            <span style={{ color: theme.ok }}>$ </span>
            {command}
            <span style={{ color: theme.accent, opacity: cursorOn && command.length < COMMAND.length && frame >= T.command ? 1 : 0 }}>
              ▍
            </span>
          </div>
          <div style={{ color: theme.text, opacity: checkOne }}>
            <span style={{ color: theme.ok }}>✓ </span>Snapshot downloaded and checksum-verified
          </div>
          <div style={{ color: theme.text, opacity: checkTwo }}>
            <span style={{ color: theme.ok }}>✓ </span>congressional-disclosures.sqlite ready
          </div>

          <div style={{ marginTop: 10, whiteSpace: "pre", color: theme.text }}>
            {query.map((line, index) => (
              <div key={index}>
                <span style={{ color: theme.muted }}>{index === 0 ? "sqlite> " : "   ...> "}</span>
                {line}
              </div>
            ))}
          </div>

          <ResultTable frame={frame} fps={fps} />
        </div>
      </div>

      <footer
        style={{
          position: "absolute",
          left: CANVAS_PADDING,
          right: CANVAS_PADDING,
          bottom: 26,
          display: "flex",
          justifyContent: "space-between",
          fontFamily: theme.mono,
          fontSize: 18,
          color: theme.muted,
        }}
      >
        <span>Open source · House + Senate · 2012 to today</span>
        <span style={{ color: theme.ok, opacity: finale, fontWeight: 700 }}>Every row links to its filing</span>
      </footer>
    </AbsoluteFill>
  );
};
