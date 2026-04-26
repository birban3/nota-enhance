"use client";

import { useEffect, useState } from "react";
import { Sun, Moon } from "lucide-react";

type Theme = "light" | "dark";

interface Props {
  compact?: boolean;
}

export function ThemeToggle({ compact = false }: Props) {
  const [theme, setTheme] = useState<Theme>("dark");
  const [mounted, setMounted] = useState(false);

  useEffect(() => {
    const t = (document.documentElement.getAttribute("data-theme") as Theme) || "dark";
    setTheme(t);
    setMounted(true);
  }, []);

  const toggle = () => {
    const next: Theme = theme === "dark" ? "light" : "dark";
    setTheme(next);
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("nota-theme", next); } catch {}
  };

  if (!mounted) return <div className={compact ? "w-9 h-9" : "w-full h-9"} />;

  if (compact) {
    return (
      <button
        onClick={toggle}
        title={theme === "dark" ? "Tema chiaro" : "Tema scuro"}
        className="press w-9 h-9 flex items-center justify-center rounded-lg bg-surface-2/50 hover:bg-surface-3/70 text-text-secondary hover:text-text-primary"
      >
        {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
      </button>
    );
  }

  return (
    <button
      onClick={toggle}
      title={theme === "dark" ? "Tema chiaro" : "Tema scuro"}
      className="press w-full flex items-center justify-center gap-2 h-9 rounded-lg bg-surface-2 hover:bg-surface-3 text-text-secondary hover:text-text-primary text-[12px] font-medium"
    >
      {theme === "dark" ? <Sun size={14} /> : <Moon size={14} />}
      <span>{theme === "dark" ? "Chiaro" : "Scuro"}</span>
    </button>
  );
}
