import React from "react";
import {
  AbsoluteFill,
  interpolate,
  spring,
  useCurrentFrame,
  useVideoConfig,
} from "remotion";

import { theme } from "./theme";

const COMMAND = "npx congressional-disclosures@latest download --sqlite";

function reveal(text: string, frame: number, start: number, framesPerCharacter = 1.15): string {
  const characters = Math.max(0, Math.floor((frame - start) / framesPerCharacter));
  return text.slice(0, characters);
}

const Check: React.FC<{ visible: boolean }> = ({ visible }) => (
  <span
    style={{
      color: theme.ok,
      display: "inline-block",
      opacity: visible ? 1 : 0,
      transform: visible ? "scale(1)" : "scale(0.7)",
      width: 30,
    }}
  >
    ✓
  </span>
);

const TerminalLine: React.FC<{
  children: React.ReactNode;
  visible: number;
  color?: string;
}> = ({ children, visible, color = theme.text }) => (
  <div
    style={{
      color,
      opacity: visible,
      transform: `translateY(${interpolate(visible, [0, 1], [10, 0])}px)`,
      lineHeight: 1.55,
      whiteSpace: "pre",
    }}
  >
    {children}
  </div>
);

export const ReadmeDemo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const command = reveal(COMMAND, frame, 15);
  const titleIn = spring({ frame, fps, config: { damping: 200 } });
  const progressOne = spring({ frame: frame - 78, fps, config: { damping: 200 } });
  const progressTwo = spring({ frame: frame - 102, fps, config: { damping: 200 } });
  const progressThree = spring({ frame: frame - 126, fps, config: { damping: 200 } });
  const queryIn = spring({ frame: frame - 160, fps, config: { damping: 200 } });
  const countIn = spring({ frame: frame - 197, fps, config: { damping: 180 } });
  const cursorOn = Math.floor(frame / 12) % 2 === 0;
  const finalAccent = interpolate(frame, [198, 220], [0, 1], {
    extrapolateLeft: "clamp",
    extrapolateRight: "clamp",
  });

  return (
    <AbsoluteFill
      style={{
        background: "#080b10",
        color: theme.text,
        fontFamily: theme.sans,
        padding: "48px 56px",
      }}
    >
      <div
        style={{
          position: "absolute",
          inset: 0,
          background:
            "radial-gradient(circle at 82% 12%, rgba(88,166,255,.14), transparent 34%), linear-gradient(135deg, rgba(63,185,80,.04), transparent 45%)",
        }}
      />

      <header
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "flex-end",
          opacity: titleIn,
          transform: `translateY(${interpolate(titleIn, [0, 1], [12, 0])}px)`,
          zIndex: 1,
        }}
      >
        <div>
          <div
            style={{
              color: theme.accent,
              fontFamily: theme.mono,
              fontSize: 18,
              fontWeight: 700,
              letterSpacing: 2.2,
              textTransform: "uppercase",
            }}
          >
            congressional-disclosures
          </div>
          <div style={{ fontSize: 38, fontWeight: 760, letterSpacing: -1.2, marginTop: 8 }}>
            From zero to queryable Congress data.
          </div>
        </div>
        <div style={{ color: theme.muted, fontFamily: theme.mono, fontSize: 18 }}>
          House + Senate · 2012–today
        </div>
      </header>

      <div
        style={{
          position: "relative",
          zIndex: 1,
          marginTop: 34,
          flex: 1,
          border: `1px solid ${theme.border}`,
          borderRadius: 16,
          overflow: "hidden",
          background: "rgba(13,17,23,.96)",
          boxShadow: "0 28px 80px rgba(0,0,0,.42)",
        }}
      >
        <div
          style={{
            height: 44,
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
          <div
            style={{
              marginLeft: 12,
              fontFamily: theme.mono,
              color: theme.muted,
              fontSize: 15,
            }}
          >
            ~/congressional-stock-trades
          </div>
        </div>

        <div
          style={{
            padding: "28px 34px",
            fontFamily: theme.mono,
            fontSize: 21,
            letterSpacing: -0.35,
          }}
        >
          <div style={{ minHeight: 42, whiteSpace: "pre" }}>
            <span style={{ color: theme.ok }}>$ </span>
            <span>{command}</span>
            <span style={{ color: theme.accent, opacity: cursorOn && command.length < COMMAND.length ? 1 : 0 }}>
              ▍
            </span>
          </div>

          <div style={{ marginTop: 18 }}>
            <TerminalLine visible={progressOne}>
              <Check visible={progressOne > 0.65} /> Parquet snapshot downloaded and checksum-verified
            </TerminalLine>
            <TerminalLine visible={progressTwo}>
              <Check visible={progressTwo > 0.65} /> House + Senate trades materialized
            </TerminalLine>
            <TerminalLine visible={progressThree}>
              <Check visible={progressThree > 0.65} /> congressional-disclosures.sqlite ready
            </TerminalLine>
          </div>

          <div
            style={{
              marginTop: 18,
              paddingTop: 18,
              borderTop: `1px solid rgba(139,148,158,${0.18 * queryIn})`,
              opacity: queryIn,
            }}
          >
            <TerminalLine visible={queryIn} color={theme.muted}>
              sqlite&gt; SELECT ticker, action FROM political_trade_events LIMIT 10;
            </TerminalLine>
            <div
              style={{
                color: theme.text,
                fontSize: 42,
                fontWeight: 750,
                marginTop: 4,
                opacity: countIn,
                transform: `translateY(${interpolate(countIn, [0, 1], [8, 0])}px)`,
              }}
            >
              10 rows
              <span style={{ color: theme.muted, fontSize: 18, fontWeight: 500, marginLeft: 14 }}>
                ready for your query
              </span>
            </div>
          </div>
        </div>
      </div>

      <footer
        style={{
          position: "relative",
          zIndex: 1,
          marginTop: 22,
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          fontFamily: theme.mono,
          fontSize: 17,
          color: theme.muted,
        }}
      >
        <span>No API keys. No Docker. Ordinary SQL.</span>
        <span style={{ color: `rgba(63,185,80,${finalAccent})`, fontWeight: 700 }}>
          One command → a real SQLite database.
        </span>
      </footer>
    </AbsoluteFill>
  );
};
