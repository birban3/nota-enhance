// Full-screen loading splash shown while a page hydrates / checks the session.
// Replaces the old static "Caricamento…" text with the animated wordmark so a
// brief load still feels on-brand.

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
