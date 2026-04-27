import type { MetadataRoute } from "next";

// PWA manifest — read by Chrome/Edge "Install app", macOS Safari 17+
// "Add to Dock", and Android Chrome "Add to Home screen". iOS reads it
// too in PWA contexts but the home-screen tile is driven by
// apple-icon.tsx instead.
//
// We keep the icon set tight (the auto-generated SVG + the apple-icon
// PNG) — bigger PNG sizes aren't needed because Safari/Chrome rasterise
// the SVG for any tile size they need.

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "nota/enhance",
    short_name: "nota/enhance",
    description: "AI-powered note enhancement with live audio transcription",
    start_url: "/",
    display: "standalone",
    background_color: "#0a0a0b",
    theme_color: "#0a0a0b",
    orientation: "portrait",
    icons: [
      {
        src: "/icon.svg",
        sizes: "any",
        type: "image/svg+xml",
        purpose: "any",
      },
      {
        src: "/apple-icon",
        sizes: "180x180",
        type: "image/png",
        purpose: "any",
      },
    ],
  };
}
