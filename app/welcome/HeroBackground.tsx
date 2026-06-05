"use client";

// Decorative background for the landing hero. Subtle, brand-coherent, and
// thematically tied to the product: a column of "scribbled notes" on the
// left whose ink is slowly drifting / re-ordering itself into a column of
// clean lines on the right — the visual analogue of the headline ("le note
// di lezione, sistemate da sole").
//
// All inline SVG, no JS animation, no external libs. The animation uses
// SMIL <animate> tags which every modern browser supports; `@media
// (prefers-reduced-motion: reduce)` (via the wrapping CSS variable) freezes
// it for users who've asked for less motion.
//
// Brand colour comes from `text-accent` (orange #A84309 / #C24E0C light).
// Each "line" is rendered through `currentColor` so theming flips with the
// rest of the page.

import { useEffect, useState } from "react";

const LEFT_X = 40;
const RIGHT_X = 320;
const COL_WIDTH = 220;

// A "messy" line: short segments with random gaps + jitter to feel scribbled.
function ScribbleLine({ y, seed }: { y: number; seed: number }) {
  // Deterministic pseudo-random so server- and client-rendered SVGs match
  // (Next would otherwise warn about hydration mismatch).
  const rand = (n: number) => {
    const x = Math.sin(seed * 9301 + n * 49297) * 233280;
    return x - Math.floor(x);
  };
  // 3-5 segments per scribble line, varying widths + gaps.
  const segments: { x: number; w: number }[] = [];
  let cursor = 0;
  while (cursor < COL_WIDTH - 15) {
    const w = 18 + rand(segments.length) * 32;
    segments.push({ x: cursor, w });
    cursor += w + 8 + rand(segments.length + 7) * 14;
  }
  return (
    <g opacity="0.45">
      {segments.map((s, i) => (
        <rect
          key={i}
          x={LEFT_X + s.x}
          y={y + rand(i + 13) * 2 - 1}
          width={s.w}
          height={2}
          rx={1}
          fill="currentColor"
        />
      ))}
    </g>
  );
}

// A "clean" line: single full-width bar, slightly translucent so the column
// reads as text rather than a solid block.
function CleanLine({ y, w = COL_WIDTH }: { y: number; w?: number }) {
  return (
    <rect
      x={RIGHT_X}
      y={y}
      width={w}
      height={2.5}
      rx={1.25}
      fill="currentColor"
      opacity="0.85"
    />
  );
}

// A travelling dot that drifts left → right across each row at a slightly
// different cadence, representing the "ink finding its place".
function TravelingDot({ y, delay }: { y: number; delay: number }) {
  return (
    <circle r={2.4} fill="currentColor" opacity="0.7">
      <animate
        attributeName="cx"
        from={LEFT_X + 60}
        to={RIGHT_X + COL_WIDTH - 6}
        dur="5.5s"
        begin={`${delay}s`}
        repeatCount="indefinite"
      />
      <animate
        attributeName="cy"
        values={`${y - 1};${y};${y - 0.5};${y}`}
        keyTimes="0;0.4;0.7;1"
        dur="5.5s"
        begin={`${delay}s`}
        repeatCount="indefinite"
      />
      <animate
        attributeName="opacity"
        values="0;0.7;0.7;0"
        keyTimes="0;0.15;0.85;1"
        dur="5.5s"
        begin={`${delay}s`}
        repeatCount="indefinite"
      />
    </circle>
  );
}

const ROWS = [60, 100, 140, 180, 220, 260, 300, 340];

export function HeroBackground() {
  // Defer rendering until after mount so server-side SSR doesn't ship the
  // animated nodes (which would be inert anyway, but they'd add bytes to a
  // page where SEO matters).
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);
  if (!mounted) return null;

  // Layout: the SVG is positioned absolute, full-width, behind the hero
  // content. The aspect ratio is preserved while the SVG stretches; pointer
  // events are disabled so the user can still click through to the CTAs.
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-x-0 top-0 h-[680px] overflow-hidden text-accent reduce-motion-freeze"
      style={{
        // Fades the whole graphic out at the bottom so it doesn't compete
        // with the feature cards further down.
        WebkitMaskImage:
          "linear-gradient(180deg, black 0%, black 60%, transparent 100%)",
        maskImage:
          "linear-gradient(180deg, black 0%, black 60%, transparent 100%)",
        opacity: 0.55,
      }}
    >
      {/* Two large mirrored copies of the column-pair: one biased to the
          left side of the viewport, one to the right, so the composition
          fills the hero regardless of aspect ratio. */}
      <svg
        viewBox="0 0 1440 680"
        preserveAspectRatio="xMidYMid slice"
        className="w-full h-full"
      >
        <g transform="translate(80 80)">
          {ROWS.map((y, i) => (
            <g key={`l${i}`}>
              <ScribbleLine y={y} seed={i + 1} />
              <CleanLine
                y={y}
                w={COL_WIDTH * (0.55 + ((i * 37) % 100) / 280)}
              />
              <TravelingDot y={y} delay={i * 0.4} />
            </g>
          ))}
        </g>
        <g transform="translate(880 130)" opacity="0.5">
          {ROWS.map((y, i) => (
            <g key={`r${i}`}>
              <ScribbleLine y={y} seed={i + 7} />
              <CleanLine
                y={y}
                w={COL_WIDTH * (0.6 + ((i * 53) % 100) / 300)}
              />
              <TravelingDot y={y} delay={1.4 + i * 0.4} />
            </g>
          ))}
        </g>
      </svg>
    </div>
  );
}
