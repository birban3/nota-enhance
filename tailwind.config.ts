import type { Config } from "tailwindcss";

const config: Config = {
  darkMode: ['class', '[data-theme="dark"]'],
  content: [
    "./app/**/*.{ts,tsx}",
    "./components/**/*.{ts,tsx}",
  ],
  theme: {
    extend: {
      colors: {
        surface: {
          0: "var(--surface-0)",
          1: "var(--surface-1)",
          2: "var(--surface-2)",
          3: "var(--surface-3)",
          4: "var(--surface-4)",
        },
        // Hermès Deep Orange — a richer, more saturated take on Orange H
        // (≈ Pantone 1665 C). `light` is a vivid top-stop used in multi-stop
        // button gradients to give pronounced depth. `dark` is the bottom-stop.
        accent: {
          light: "#E5651A",
          DEFAULT: "#A84309",
          dark: "#5C2306",
        },
        // Hermès Rouge H (code 46) — premium deep red matched to the brand's
        // leather swatch. `light` brightens the gradient top for visible vibrance.
        rec: {
          light: "#E55552",
          DEFAULT: "#D4403D",
          dark: "#7A1F1D",
        },
        text: {
          primary: "var(--text-primary)",
          secondary: "var(--text-secondary)",
          muted: "var(--text-muted)",
          faint: "var(--text-faint)",
          emphasis: "var(--text-emphasis)",
        },
      },
      fontFamily: {
        sans: ['"IBM Plex Sans"', "system-ui", "sans-serif"],
        mono: ['"IBM Plex Mono"', "monospace"],
      },
    },
  },
  plugins: [],
};

export default config;
