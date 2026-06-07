"use client";

import { useEffect, useState, useCallback, useMemo } from "react";
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

const SPOTLIGHT_PADDING = 8;

// ── Fixed-element scale probe ──
//
// The app sets `html { zoom: 1.15 }` on desktop. The hard part: how CSS
// `zoom` interacts with getBoundingClientRect() and with the `top/left` of a
// `position:fixed` element is INCONSISTENT across browsers. In some
// (recent Chromium) getBoundingClientRect returns visual/zoomed pixels while
// the `top` you write is layout pixels (so they differ by the zoom factor);
// in others they agree. Reading `getComputedStyle(html).zoom` told us the
// CSS value but NOT which of those two regimes the browser is in — so a
// fixed division over-corrected on the browsers that don't scale fixed
// coords, flipping the spotlight misalignment to the opposite side.
//
// Instead we MEASURE the actual relationship at runtime: drop a 100px-wide
// `position:fixed` probe and read its rect width. The ratio rect/100 is
// exactly the factor F such that `renderedRect = cssValue * F`. To make a
// fixed element's rect line up with a target's rect we then set
// `cssValue = targetRect / F`. This is correct in EVERY browser regardless
// of how it chose to handle zoom. Cached for 1s so the per-frame tracking
// loop doesn't thrash the DOM.
let _scale = 0;
let _scaleAt = 0;
function fixedScale(): number {
  if (typeof document === "undefined") return 1;
  const t = typeof performance !== "undefined" ? performance.now() : Date.now();
  if (_scale && t - _scaleAt < 1000) return _scale;
  try {
    const probe = document.createElement("div");
    probe.style.cssText =
      "position:fixed;top:0;left:0;width:100px;height:100px;visibility:hidden;pointer-events:none;margin:0;padding:0;border:0";
    document.body.appendChild(probe);
    const w = probe.getBoundingClientRect().width;
    document.body.removeChild(probe);
    _scale = w > 0 ? w / 100 : 1;
  } catch {
    _scale = 1;
  }
  _scaleAt = t;
  return _scale;
}
// Back-compat alias — callers below still read the "zoom" factor; it's now
// the measured fixed-element scale (correct cross-browser).
const getZoom = fixedScale;

function getRectFor(selector: string): Rect | null {
  if (typeof document === "undefined") return null;
  const el = document.querySelector<HTMLElement>(`[data-tour="${selector}"]`);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  // Discard offscreen / zero-size matches (e.g. an element that's
  // display:none because we're below md). The caller treats null as
  // "skip the spotlight, show a centred card".
  if (r.width === 0 || r.height === 0) return null;
  // getBoundingClientRect() returns VISUAL pixels (post-zoom), but the CSS
  // top/left/width/height we write for the spotlight are LAYOUT pixels and
  // get multiplied by html{zoom:1.15} at render. Without dividing, the
  // spotlight rendered ~1.15× off the target on desktop (step 11 measured:
  // target top=730 visual, spotlight rendering at 824 = 716×1.15). Dividing
  // by the zoom factor puts the rect in layout space so the CSS engine's own
  // ×zoom lands it back on the target. Mobile is zoom:1 → no-op (where the
  // bug never appeared).
  const z = getZoom();
  return {
    top: r.top / z - SPOTLIGHT_PADDING,
    left: r.left / z - SPOTLIGHT_PADDING,
    width: r.width / z + SPOTLIGHT_PADDING * 2,
    height: r.height / z + SPOTLIGHT_PADDING * 2,
  };
}

// Dock-side decision for the tooltip card.
//
// Why a flex dock instead of absolute pixel placement: previous iterations
// computed `top:` / `left:` for a `position:fixed` card and then clamped it
// inside `window.innerWidth/Height`. Under `html { zoom: 1.15 }` the meaning
// of `top:` written to a fixed element vs. what `getBoundingClientRect()`
// returns is *inconsistent across browsers* (some scale, some don't). Even
// after measuring the real ratio with a probe, the card kept landing with the
// "Avanti" button below the viewport on tall steps (4 = editor pane, 11 =
// account link near sidebar bottom) on some browsers.
//
// The flex approach sidesteps the whole zoom mess: a fixed `inset-0` container
// uses no pixel math; flex `items-start` / `items-end` / `items-center` dock
// the card to a viewport edge; the card carries `max-h-full` + an internal
// scroll region so its footer (with the Avanti button) is structurally always
// in view. The only pixel math left is the spotlight rect, which is meant to
// track its target — and a small visual misalignment there is far less bad
// than the user being unable to press Avanti.
type Dock = "top" | "bottom" | "center";

function pickDock(rect: Rect | null, preferred: TourStep["placement"]): Dock {
  if (!rect || typeof window === "undefined") return "center";
  // Honour an explicit placement hint when given, except `auto` which means
  // "pick whichever side has more room".
  if (preferred === "top") return "top";
  if (preferred === "bottom") return "bottom";
  const vh = window.innerHeight / getZoom();
  const targetCenter = rect.top + rect.height / 2;
  // Target in the top half → card docks to the bottom (out of the way of the
  // spotlight). Target in the bottom half → card docks to the top.
  return targetCenter < vh / 2 ? "bottom" : "top";
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
    // Settle-loop: re-read the rect every frame for the first 600 ms after a
    // step appears. Transform-based animations (the sidebar's slide-in
    // spring) don't trigger resize/scroll/ResizeObserver — the element's box
    // size and DOM position are unchanged, only an ancestor's transform
    // moved it — so without this the spotlight stuck to the pre-animation
    // position for ~half a second on sidebar-anchored steps.
    let alive = true;
    const start = performance.now();
    const settle = () => {
      if (!alive) return;
      tick();
      if (performance.now() - start < 600) requestAnimationFrame(settle);
    };
    requestAnimationFrame(settle);
    return () => {
      alive = false;
      cancelAnimationFrame(raf);
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

  const dock = useMemo(() => pickDock(rect, step?.placement), [rect, step?.placement]);

  if (!open || !step) return null;

  const isLast = index === steps.length - 1;
  const isFirst = index === 0;
  const dockAlign =
    dock === "top" ? "items-start" : dock === "bottom" ? "items-end" : "items-center";

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
            // Flex dock — the card is parked at the top, bottom or centre of
            // the viewport via flex alignment, never with `top:` / `left:`
            // pixel math. The card itself caps at `max-h-full` and its body
            // scrolls internally, so the footer (Avanti) is always visible.
            // Container is pointer-events:none so clicks on the empty area
            // around the card fall through to the dismiss layer below.
            <div
              className={`fixed inset-0 flex justify-center p-4 pointer-events-none pt-safe pb-safe ${dockAlign}`}
            >
              <motion.div
                key={`card-${step.id}`}
                className="pointer-events-auto material-thick rounded-2xl border shadow-float w-[320px] max-w-full max-h-full flex flex-col"
                initial={{ opacity: 0, scale: 0.96, y: 4 }}
                animate={{ opacity: 1, scale: 1, y: 0 }}
                exit={{ opacity: 0, scale: 0.96, y: 4 }}
                transition={{ type: "spring", stiffness: 420, damping: 30, mass: 0.7 }}
                onClick={(e) => e.stopPropagation()}
              >
                {/* Header — fixed, doesn't scroll. */}
                <div className="flex items-start gap-3 p-5 pb-3 shrink-0">
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

                {/* Body — scrolls internally when the card hits max-h-full. */}
                <div className="px-5 overflow-y-auto flex-1 min-h-0">
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
                </div>

                {/* Footer — fixed, always visible at the bottom of the card. */}
                <div className="flex items-center gap-2 p-5 pt-3 shrink-0 border-t border-[var(--material-border)]/40">
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
            </div>
          )}
        </div>
      )}
    </AnimatePresence>
  );
}
