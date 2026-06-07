// Full-screen loading splash shown while a page hydrates / checks the session.
// Replaces the old static "Caricamento…" text with the animated wordmark so a
// brief load still feels on-brand.

import { useEffect, useState } from "react";

// How long the splash stays up at minimum — enough for the "/ enhance"
// typewriter (0.95s) to finish plus a short beat, so a fast load doesn't cut
// the animation off mid-type. Keep in sync with the brand-type-grow duration
// in globals.css.
export const BRAND_LOADER_MIN_MS = 1150;

// Gate for "should the loading splash stay visible?". Returns true while EITHER
// the real work is still going (`loading`) OR the minimum on-screen time hasn't
// elapsed yet — so even if the page is ready before the typewriter finishes, we
// hold the splash until the animation completes. The timer starts when the
// component using this hook first mounts (i.e. when the splash first appears).
export function useBrandLoaderGate(loading: boolean, minMs: number = BRAND_LOADER_MIN_MS): boolean {
  const [minElapsed, setMinElapsed] = useState(false);
  useEffect(() => {
    const t = setTimeout(() => setMinElapsed(true), minMs);
    return () => clearTimeout(t);
  }, [minMs]);
  return loading || !minElapsed;
}

// Reusable inline animated wordmark: "nota" sits fixed in place and only the
// "/ enhance" part is typed out left-to-right in character-sized steps, with a
// blinking caret, in accent orange.
//
// How the typewriter works without measuring text width: an invisible copy of
// the typed string sets the box width, then an absolutely-positioned overlay
// grows from width:0 → 100% in `steps()` (so it reads as typed characters, not
// a smooth wipe) with a border-right caret that rides along. Width-agnostic,
// so it's correct for the proportional brand font on any screen.
export function BrandWordmark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`font-bold tracking-tight select-none whitespace-nowrap ${className}`}
      role="img"
      aria-label="nota / enhance"
    >
      <span className="text-text-emphasis">nota</span>
      <span className="brand-type text-accent">
        <span className="invisible" aria-hidden="true">&nbsp;/ enhance</span>
        <span className="brand-type-fill" aria-hidden="true">&nbsp;/ enhance</span>
      </span>
    </span>
  );
}

export function BrandLoader() {
  return (
    <div className="h-dvh flex items-center justify-center bg-surface-0">
      <BrandWordmark className="text-2xl md:text-3xl" />
    </div>
  );
}
