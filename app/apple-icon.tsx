// Apple touch icon — used by iOS Safari when the user picks "Add to Home
// Screen", and by macOS Safari (16+) when adding the site to the Dock.
//
// iOS *cannot* use the SVG favicon for the home-screen tile, so we render
// the same orange-star/dark-square mark to a 180×180 PNG via Next.js's
// ImageResponse helper. Next.js auto-emits the right <link rel="apple-
// touch-icon"> tag because of this file's name.

import { ImageResponse } from "next/og";

export const size = { width: 180, height: 180 };
export const contentType = "image/png";

export default function AppleIcon() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          background: "#0a0a0b",
          // iOS rounds the tile itself; we leave the canvas square and let
          // the OS apply its standard mask. (Drawing our own rounded
          // corners would compound with the mask and look pinched.)
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
        }}
      >
        {/* Same 4-point sparkle as the SVG favicon, scaled for 180px */}
        <svg width="120" height="120" viewBox="0 0 32 32">
          <path
            d="M16 7l1.8 5.4 5.4 1.8-5.4 1.8L16 21.4l-1.8-5.4-5.4-1.8 5.4-1.8L16 7z"
            fill="#C24E0C"
          />
        </svg>
      </div>
    ),
    size
  );
}
