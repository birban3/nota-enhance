"use client";

import { useEffect, useState, useCallback, useMemo, useLayoutEffect, useRef } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ArrowRight, ArrowLeft, X, Sparkles, Check } from "lucide-react";

/**
 * Interactive product tour for the editor app.
 *
 * Each step optionally targets a DOM element by `data-tour="key"`. The
 * element is "spotlit" — visible inside a hole punched in the dimmed
 * backdrop — and a tooltip card explains what to do. Steps without a
 * target render as a centred card (welcome / outro / a target hidden at
 * the current breakpoint).
 *
 * Spotlight implementation: a fixed div sized to the target's
 * getBoundingClientRect() with a giant inset box-shadow that paints
 * everything outside it dark. No SVG masks needed.
 *
 * Mobile gotcha: many targets live inside the slide-over sidebar.
 * `beforeShow` hooks open the sidebar (or anything else) before the
 * spotlight tries to find them, and we poll the target rect for a few
 * frames so the slide-in animation has time to settle.
 *
 * Layout shifts during a step (resize, scroll, sidebar animating) are
 * tracked via ResizeObserver + scroll/resize listeners — the spotlight
 * follows its target.
 */

export interface TourStep {
  id: string;
  title: string;
  body: string;
  /** data-tour attribute on the element to highlight. Omit for a centred
   *  step with no spotlight (intro / outro). */
  target?: string;
  /** Side of the target to place the tooltip on. `auto` picks whichever
   *  side has more room. */
  placement?: "top" | "bottom" | "left" | "right" | "auto";
  /** Run before the step shows (e.g. open the sidebar). Awaited. */
  beforeShow?: () => Promise<void> | void;
  /** Optional final CTA label override ("Iniziamo" vs "Avanti"). */
  ctaLabel?: string;
}

interface Props {
  open: boolean;
  steps: TourStep[];
  onClose: (completed: boolean) => void;
}

interface Rect { top: number; left: number; width: number; height: number; }

const TOOLTIP_W = 320;
const TOOLTIP_H_ESTIMATE = 200;
const SPOTLIGHT_PADDING = 8;
const VIEWPORT_MARGIN = 16;

// The app sets `html { zoom: 1.15 }` on desktop (globals.css). Under CSS
// zoom, getBoundingClientRect(), offsetWidth/Height and the `top`/`left` we
// write are all in LAYOUT pixels (pre-zoom) and agree with each other — but
// window.innerWidth/innerHeight report VISUAL (device) pixels. Mixing the two
// in the viewport-clamp math placed the card ~zoom× too low, pushing the
// footer (Avanti button) off-screen. Dividing the visual viewport by the
// zoom factor brings everything into the same layout-pixel space.
function getZoom(): number {
  if (typeof window === "undefined") return 1;
  const z = parseFloat(getComputedStyle(document.documentElement).zoom || "1");
  return z && !Number.isNaN(z) ? z : 1;
}

function getRectFor(selector: string): Rect | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector<HTMLElement>(`[data-tour="${selector}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // Discard offscreen / zero-size matches (e.g. an element that's
  // display:none because we're below md). The caller treats null as
  // "skip the spotlight, show a centred card".
  if (r.width === 0 || r.height === 0) return null;
  return {
    top: r.top - SPOTLIGHT_PADDING,
    left: r.left - SPOTLIGHT_PADDING,
    width: r.width + SPOTLIGHT_PADDING * 2,
    height: r.height + SPOTLIGHT_PADDING * 2,
  };
}

function placeTooltip(
  rect: Rect | null,
  preferred: TourStep["placement"]
): { top: number; left: number } {
  const zoom = getZoom();
  if (!rect || typeof window === "undefined") {
    const w = typeof window !== "undefined" ? window.innerWidth / zoom : 1024;
    const h = typeof window !== "undefined" ? window.innerHeight / zoom : 768;
    return {
      top: Math.max(VIEWPORT_MARGIN, (h - TOOLTIP_H_ESTIMATE) / 2),
      left: Math.max(VIEWPORT_MARGIN, (w - TOOLTIP_W) / 2),
    };
  }

  // Layout-pixel viewport (see getZoom): rect is already layout px.
  const vw = window.innerWidth / zoom;
  const vh = window.innerHeight / zoom;
  const room = {
    top: rect.top - VIEWPORT_MARGIN,
    bottom: vh - (rect.top + rect.height) - VIEWPORT_MARGIN,
    left: rect.left - VIEWPORT_MARGIN,
    right: vw - (rect.left + rect.width) - VIEWPORT_MARGIN,
  };
  let side: "top" | "bottom" | "left" | "right" =
    preferred && preferred !== "auto" ? preferred : "bottom";
  // Switch sides when the preferred one doesn't fit.
  if (side === "bottom" && room.bottom < TOOLTIP_H_ESTIMATE) side = "top";
  if (side === "top" && room.top < TOOLTIP_H_ESTIMATE) side = "bottom";
  if (side === "right" && room.right < TOOLTIP_W + 12) side = "left";
  if (side === "left" && room.left < TOOLTIP_W + 12) side = "right";

  let top = 0;
  let left = 0;
  if (side === "bottom") {
    top = rect.top + rect.height + 12;
    left = rect.left + rect.width / 2 - TOOLTIP_W / 2;
  } else if (side === "top") {
    top = rect.top - TOOLTIP_H_ESTIMATE - 12;
    left = rect.left + rect.width / 2 - TOOLTIP_W / 2;
  } else if (side === "right") {
    top = rect.top + rect.height / 2 - TOOLTIP_H_ESTIMATE / 2;
    left = rect.left + rect.width + 12;
  } else {
    top = rect.top + rect.height / 2 - TOOLTIP_H_ESTIMATE / 2;
    left = rect.left - TOOLTIP_W - 12;
  }
  // Clamp inside the viewport so the tooltip is never half off-screen.
  left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - TOOLTIP_W - VIEWPORT_MARGIN));
  top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - TOOLTIP_H_ESTIMATE - VIEWPORT_MARGIN));
  return { top, left };
}

export function OnboardingTour({ open, steps, onClose }: Props) {
  const [index, setIndex] = useState(0);
  const [rect, setRect] = useState<Rect | null>(null);
  const [ready, setReady] = useState(false);

  const step = steps[index];

  // Reset when reopened — restart from step 0.
  useEffect(() => {
    if (open) {
      setIndex(0);
      setReady(false);
    }
  }, [open]);

  // Run beforeShow + resolve target rect for the current step. We poll a few
  // times because the target might appear a frame or two after beforeShow
  // runs (e.g. the sidebar finishes its slide-in animation).
  useEffect(() => {
    if (!open || !step) return;
    let cancelled = false;
    setReady(false);
    (async () => {
      try { await step.beforeShow?.(); } catch {}
      if (!step.target) {
        if (!cancelled) { setRect(null); setReady(true); }
        return;
      }
      for (let i = 0; i < 12 && !cancelled; i++) {
        const r = getRectFor(step.target);
        if (r) {
          setRect(r);
          setReady(true);
          return;
        }
        await new Promise((res) => setTimeout(res, 100));
      }
      if (!cancelled) { setRect(null); setReady(true); }
    })();
    return () => { cancelled = true; };
  }, [open, step]);

  // Track resize/scroll/layout shifts mid-step.
  useEffect(() => {
    if (!open || !step?.target || !ready) return;
    let raf = 0;
    const tick = () => {
      const r = getRectFor(step.target!);
      setRect(r);
    };
    const schedule = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(tick);
    };
    window.addEventListener("resize", schedule);
    window.addEventListener("scroll", schedule, true);
    const el = document.querySelector<HTMLElement>(`[data-tour="${step.target}"]`);
    const ro = el ? new ResizeObserver(schedule) : null;
    if (el && ro) ro.observe(el);

    // Container-animation follow: when a step's target lives inside an
    // element that animates into place (the sidebar slides + scales in via
    // framer-motion for steps like "account"/"sidebar"/"new-note"), the
    // target's on-screen rect keeps changing for a few hundred ms AFTER it
    // first becomes measurable. A CSS transform animation fires neither
    // `resize`, `scroll`, nor `ResizeObserver` (the layout box doesn't
    // change — only the transform does), so the initial measurement landed
    // mid-animation and the spotlight stayed off-centre (most visible on the
    // small profile icon in the final steps). Re-measure every frame for a
    // bounded window so the lens settles exactly over its target.
    let followRaf = 0;
    const settleUntil = performance.now() + 700;
    const follow = () => {
      const r = getRectFor(step.target!);
      if (r) setRect(r);
      if (performance.now() < settleUntil) {
        followRaf = requestAnimationFrame(follow);
      }
    };
    followRaf = requestAnimationFrame(follow);

    return () => {
      cancelAnimationFrame(raf);
      cancelAnimationFrame(followRaf);
      window.removeEventListener("resize", schedule);
      window.removeEventListener("scroll", schedule, true);
      ro?.disconnect();
    };
  }, [open, step, ready]);

  const next = useCallback(() => {
    if (index >= steps.length - 1) onClose(true);
    else setIndex((i) => i + 1);
  }, [index, steps.length, onClose]);

  const prev = useCallback(() => {
    setIndex((i) => Math.max(0, i - 1));
  }, []);

  // Keyboard: Esc closes, Enter / → advances, ← back.
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") { e.preventDefault(); onClose(false); }
      else if (e.key === "ArrowRight" || e.key === "Enter") { e.preventDefault(); next(); }
      else if (e.key === "ArrowLeft") { e.preventDefault(); prev(); }
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open, next, prev, onClose]);

  const placement = useMemo(() => placeTooltip(rect, step?.placement), [rect, step?.placement]);

  // `placement` uses an ESTIMATED card height (TOOLTIP_H_ESTIMATE) for its
  // viewport clamp. When the real card is taller than the estimate — long
  // body text, narrow screens where text wraps, or a step anchored to a
  // huge target like the editor pane — the bottom (with the Avanti button)
  // overflowed off-screen. After the card renders we measure its true
  // layout size and re-clamp so it's always fully inside the viewport. We
  // use offsetWidth/Height (not getBoundingClientRect) so framer-motion's
  // entry scale transform doesn't skew the measurement.
  const cardRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ top: number; left: number; maxHeight?: number } | null>(null);

  useLayoutEffect(() => {
    const el = cardRef.current;
    if (!el || typeof window === "undefined") return;
    // Layout-pixel viewport — offsetWidth/Height and the top/left we set are
    // already layout px; only innerWidth/Height need the zoom division.
    const zoom = getZoom();
    const vw = window.innerWidth / zoom;
    const vh = window.innerHeight / zoom;
    const h = el.offsetHeight;
    const w = el.offsetWidth;
    let top = placement.top;
    let left = placement.left;
    let maxHeight: number | undefined;
    // If the card is taller than the usable viewport, pin it to the top
    // margin and cap its height (its body scrolls internally) so the footer
    // buttons stay reachable. Otherwise clamp so the whole card fits.
    const usableH = vh - VIEWPORT_MARGIN * 2;
    if (h > usableH) {
      top = VIEWPORT_MARGIN;
      maxHeight = usableH;
    } else {
      top = Math.max(VIEWPORT_MARGIN, Math.min(top, vh - h - VIEWPORT_MARGIN));
    }
    left = Math.max(VIEWPORT_MARGIN, Math.min(left, vw - w - VIEWPORT_MARGIN));
    // Guard against an update loop: only commit when something actually
    // moved by more than a sub-pixel.
    setPos((prev) => {
      if (
        prev &&
        Math.abs(prev.top - top) < 0.5 &&
        Math.abs(prev.left - left) < 0.5 &&
        prev.maxHeight === maxHeight
      ) {
        return prev;
      }
      return { top, left, maxHeight };
    });
  }, [placement.top, placement.left, index, ready, rect]);

  // NB: no separate "reset pos on step change" effect. A passive useEffect
  // would run AFTER this useLayoutEffect and null out the correction it just
  // computed (the layout effect wouldn't re-run because its deps didn't
  // change), leaving the card on the estimate-based position → off-screen.
  // The layout effect already recomputes before paint whenever the step /
  // placement / rect changes, so there's no flash to guard against.

  if (!open || !step) return null;

  const cardPos: { top: number; left: number; maxHeight?: number } = pos ?? placement;

  const isLast = index === steps.length - 1;
  const isFirst = index === 0;

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[80]" aria-modal="true" role="dialog">
          {/* Spotlight (highlights the target) or plain backdrop (centred steps). */}
          {rect && ready ? (
            <motion.div
              key={`spot-${step.id}`}
              className="fixed pointer-events-none"
              style={{
                top: rect.top,
                left: rect.left,
                width: rect.width,
                height: rect.height,
                borderRadius: 12,
                boxShadow:
                  "0 0 0 9999px rgba(0, 0, 0, 0.55), 0 0 0 2px rgba(255, 255, 255, 0.08), 0 0 28px rgba(168, 67, 9, 0.45)",
                transition:
                  "top 240ms ease, left 240ms ease, width 240ms ease, height 240ms ease",
              }}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            />
          ) : (
            <motion.div
              className="fixed inset-0 bg-black/55"
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
            />
          )}

          {/* Click-anywhere-outside-card to dismiss. */}
          <div className="fixed inset-0" onClick={() => onClose(false)} />

          {ready && (
            <motion.div
              ref={cardRef}
              key={`card-${step.id}`}
              className="fixed material-thick rounded-2xl border shadow-float p-5 overflow-y-auto"
              style={{
                top: cardPos.top,
                left: cardPos.left,
                width: TOOLTIP_W,
                maxWidth: "calc(100vw - 32px)",
                maxHeight: cardPos.maxHeight,
              }}
              initial={{ opacity: 0, scale: 0.96, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 4 }}
              transition={{ type: "spring", stiffness: 420, damping: 30, mass: 0.7 }}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start gap-3 mb-3">
                <div className="w-7 h-7 rounded-lg bg-accent/15 border border-accent/25 flex items-center justify-center shrink-0">
                  {isLast ? <Check size={13} className="text-accent" /> : <Sparkles size={13} className="text-accent" />}
                </div>
                <div className="flex-1 min-w-0">
                  <div className="text-[10px] font-mono uppercase tracking-[0.18em] text-text-faint mb-0.5">
                    {index + 1} / {steps.length}
                  </div>
                  <h3 className="text-[14.5px] font-semibold text-text-emphasis tracking-tight leading-snug">
                    {step.title}
                  </h3>
                </div>
                <button
                  onClick={() => onClose(false)}
                  title="Salta il tutorial"
                  className="press w-7 h-7 flex items-center justify-center rounded-lg text-text-muted hover:text-text-primary hover:bg-surface-3/40 -mt-1 -mr-1"
                >
                  <X size={14} />
                </button>
              </div>
              <p className="text-[13px] text-text-secondary leading-relaxed mb-4">
                {step.body}
              </p>

              <div className="flex items-center gap-1 mb-4">
                {steps.map((_, i) => (
                  <span
                    key={i}
                    className={`h-1.5 rounded-full transition-all ${
                      i === index
                        ? "w-6 bg-accent"
                        : i < index
                        ? "w-1.5 bg-accent/40"
                        : "w-1.5 bg-text-faint/30"
                    }`}
                  />
                ))}
              </div>

              <div className="flex items-center gap-2">
                {!isFirst && (
                  <button
                    onClick={prev}
                    className="press inline-flex items-center gap-1 h-8 px-3 rounded-lg text-text-muted hover:text-text-primary text-[12.5px] font-medium"
                  >
                    <ArrowLeft size={12} /> Indietro
                  </button>
                )}
                <div className="flex-1" />
                <button
                  onClick={() => onClose(false)}
                  className="press text-text-faint hover:text-text-secondary text-[11.5px]"
                >
                  Salta
                </button>
                <button
                  onClick={next}
                  className="btn-premium-accent press inline-flex items-center gap-1.5 h-8 px-3.5 rounded-lg text-[12.5px] font-medium"
                >
                  {step.ctaLabel ?? (isLast ? "Fine" : "Avanti")}
                  {!isLast && <ArrowRight size={12} />}
                </button>
              </div>
            </motion.div>
          )}
        </div>
      )}
    </AnimatePresence>
  );
}
