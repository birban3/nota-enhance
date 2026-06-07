// Full-screen loading splash shown while a page hydrates / checks the session.
// Replaces the old static "Caricamento…" text with the animated wordmark so a
// brief load still feels on-brand.

// Reusable inline animated wordmark: "nota / enhance" typed out left-to-right
// in character-sized steps with a blinking caret, "/ enhance" in accent.
//
// How the typewriter works without measuring text width: an invisible copy of
// the string sets the box width, then an absolutely-positioned overlay grows
// from width:0 → 100% in `steps()` (so it reads as typed characters, not a
// smooth wipe) with a border-right caret that rides along. Width-agnostic, so
// it's correct for the proportional brand font on any screen.
export function BrandWordmark({ className = "" }: { className?: string }) {
  return (
    <span
      className={`brand-type font-bold tracking-tight select-none ${className}`}
      role="img"
      aria-label="nota / enhance"
    >
      <span className="invisible" aria-hidden="true">nota / enhance</span>
      <span className="brand-type-fill" aria-hidden="true">
        <span className="text-text-emphasis">nota</span>
        <span className="text-accent"> / enhance</span>
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
