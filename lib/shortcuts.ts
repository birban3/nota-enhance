"use client";

/**
 * App-level shortcut registry.
 *
 * Editor shortcuts (bold / italic / underline / highlight) are handled by Tiptap
 * directly and remain on Cmd+B / Cmd+I / Cmd+U / Cmd+E. They are NOT user-rebindable
 * here because they live inside the contenteditable.
 *
 * App shortcuts (palette, sidebar, new note, enhance) ARE user-rebindable and
 * persisted in localStorage.
 */

export type ShortcutId = "palette" | "sidebar" | "newNote" | "enhance" | "settings";

export interface Shortcut {
  /** Lowercase letter / key name (e.g. "k", "n", "Enter", "/") */
  key: string;
  meta: boolean; // ⌘ on macOS, Ctrl elsewhere
  shift: boolean;
  alt: boolean;
}

export const DEFAULT_SHORTCUTS: Record<ShortcutId, Shortcut> = {
  palette:  { key: "k", meta: true,  shift: false, alt: false },
  sidebar:  { key: "\\", meta: true, shift: false, alt: false }, // moved off Cmd+B (which is Tiptap bold)
  newNote:  { key: "n", meta: true,  shift: false, alt: false },
  enhance:  { key: "e", meta: true,  shift: true,  alt: false }, // moved off Cmd+E (which is now highlight)
  settings: { key: ",", meta: true,  shift: false, alt: false },
};

const STORAGE_KEY = "nota-shortcuts";

export function loadShortcuts(): Record<ShortcutId, Shortcut> {
  if (typeof window === "undefined") return DEFAULT_SHORTCUTS;
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SHORTCUTS;
    const parsed = JSON.parse(raw) as Partial<Record<ShortcutId, Shortcut>>;
    return { ...DEFAULT_SHORTCUTS, ...parsed };
  } catch {
    return DEFAULT_SHORTCUTS;
  }
}

export function saveShortcuts(s: Record<ShortcutId, Shortcut>): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(s));
  } catch {}
}

/** Pretty-print for display, e.g. ⌘⇧E */
export function formatShortcut(s: Shortcut): string {
  const isMac = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform);
  const parts: string[] = [];
  if (s.meta) parts.push(isMac ? "⌘" : "Ctrl");
  if (s.shift) parts.push(isMac ? "⇧" : "Shift");
  if (s.alt) parts.push(isMac ? "⌥" : "Alt");
  // Friendly key labels
  const keyLabel =
    s.key === " " ? "Space" :
    s.key === "Enter" ? "↵" :
    s.key === "Escape" ? "Esc" :
    s.key === "ArrowUp" ? "↑" :
    s.key === "ArrowDown" ? "↓" :
    s.key === "ArrowLeft" ? "←" :
    s.key === "ArrowRight" ? "→" :
    s.key.length === 1 ? s.key.toUpperCase() : s.key;
  parts.push(keyLabel);
  return parts.join(isMac ? "" : "+");
}

/** Test whether a KeyboardEvent matches a Shortcut binding. */
export function matchesShortcut(e: KeyboardEvent, s: Shortcut): boolean {
  const meta = e.metaKey || e.ctrlKey;
  if (s.meta !== meta) return false;
  if (s.shift !== e.shiftKey) return false;
  if (s.alt !== e.altKey) return false;
  // Compare case-insensitively for letters
  const eKey = e.key.length === 1 ? e.key.toLowerCase() : e.key;
  const sKey = s.key.length === 1 ? s.key.toLowerCase() : s.key;
  return eKey === sKey;
}

export const SHORTCUT_LABELS: Record<ShortcutId, string> = {
  palette: "Apri command palette",
  sidebar: "Apri/chiudi sidebar",
  newNote: "Nuova nota",
  enhance: "Enhance con AI",
  settings: "Apri impostazioni",
};

/** Capture a single keystroke and return a Shortcut. Returns null if user pressed only a modifier. */
export function eventToShortcut(e: KeyboardEvent): Shortcut | null {
  if (["Meta", "Control", "Shift", "Alt"].includes(e.key)) return null;
  return {
    key: e.key.length === 1 ? e.key.toLowerCase() : e.key,
    meta: e.metaKey || e.ctrlKey,
    shift: e.shiftKey,
    alt: e.altKey,
  };
}
