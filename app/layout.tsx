import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "nota/enhance",
  description: "AI-powered note enhancement with live audio transcription",
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
