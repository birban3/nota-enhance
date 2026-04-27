import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "nota/enhance",
  description: "AI-powered note enhancement with live audio transcription",
  // iOS standalone web-app behaviour. Without this, "Add to Home Screen"
  // opens the page inside Safari chrome instead of as a standalone app
  // and the title under the icon falls back to the URL.
  appleWebApp: {
    capable: true,
    title: "nota/enhance",
    statusBarStyle: "black-translucent",
  },
};

// `viewport-fit=cover` lets us paint into the iOS safe-area; `maximumScale=1`
// stops Safari auto-zooming on input focus (we already size inputs ≥16px on
// mobile to avoid the focus zoom heuristic, but this is belt-and-suspenders).
export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 5,
  viewportFit: "cover",
  themeColor: [
    { media: "(prefers-color-scheme: dark)", color: "#0a0a0b" },
    { media: "(prefers-color-scheme: light)", color: "#fafaf9" },
  ],
};

// Inline script: set data-theme BEFORE the body paints, to avoid theme flash
const themeInitScript = `
(function(){try{
  var t=localStorage.getItem('nota-theme');
  if(!t){t=window.matchMedia('(prefers-color-scheme: light)').matches?'light':'dark';}
  document.documentElement.setAttribute('data-theme',t);
}catch(_){document.documentElement.setAttribute('data-theme','dark');}})();
`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="it" suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: themeInitScript }} />
      </head>
      <body className="bg-surface-0 text-text-primary font-sans antialiased">
        {children}
      </body>
    </html>
  );
}
