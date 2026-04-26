"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { FileText, Plus, Mic, Download, Sparkles, Sun, Moon, Search, Settings } from "lucide-react";
import { AnimatePresence, motion } from "framer-motion";
import type { ArchivedNote } from "./NotesSidebar";

export interface Command {
  id: string;
  label: string;
  hint?: string;
  icon: React.ReactNode;
  action: () => void;
  group: "Azioni" | "Note";
}

interface Props {
  open: boolean;
  onClose: () => void;
  notes: ArchivedNote[];
  onSelectNote: (id: string) => void;
  onCreate: () => void;
  onStartRecord: () => void;
  onImport: () => void;
  onEnhance: () => void;
  onToggleTheme: () => void;
  onOpenSettings?: () => void;
  enhanceShortcut?: string;
}

export function CommandPalette({
  open, onClose, notes, onSelectNote, onCreate, onStartRecord, onImport, onEnhance, onToggleTheme,
  onOpenSettings, enhanceShortcut,
}: Props) {
  const [query, setQuery] = useState("");
  const [highlight, setHighlight] = useState(0);
  const inputRef = useRef<HTMLInputElement>(null);

  // Build command list
  const allCommands = useMemo<Command[]>(() => {
    const actions: Command[] = [
      { id: "new", label: "Nuova nota", icon: <Plus size={14} />, group: "Azioni", action: onCreate },
      { id: "rec", label: "Inizia registrazione", icon: <Mic size={14} />, group: "Azioni", action: onStartRecord },
      { id: "import", label: "Importa file audio", icon: <Download size={14} />, group: "Azioni", action: onImport },
      { id: "enhance", label: "Enhance con AI", hint: enhanceShortcut, icon: <Sparkles size={14} />, group: "Azioni", action: onEnhance },
      { id: "theme", label: "Cambia tema", icon: typeof window !== "undefined" && document.documentElement.getAttribute("data-theme") === "light" ? <Moon size={14} /> : <Sun size={14} />, group: "Azioni", action: onToggleTheme },
      ...(onOpenSettings
        ? [{ id: "settings", label: "Scorciatoie & impostazioni", icon: <Settings size={14} />, group: "Azioni" as const, action: onOpenSettings }]
        : []),
    ];
    const noteCmds: Command[] = [...notes]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .map((n) => ({
        id: `note-${n.id}`,
        label: n.title || "Senza titolo",
        hint: new Date(n.updatedAt).toLocaleDateString("it-IT", { day: "2-digit", month: "short" }),
        icon: <FileText size={14} />,
        group: "Note" as const,
        action: () => onSelectNote(n.id),
      }));
    return [...actions, ...noteCmds];
  }, [notes, onCreate, onStartRecord, onImport, onEnhance, onSelectNote, onToggleTheme, onOpenSettings, enhanceShortcut]);

  const filtered = useMemo(() => {
    if (!query.trim()) return allCommands;
    const q = query.toLowerCase();
    return allCommands.filter((c) => c.label.toLowerCase().includes(q));
  }, [allCommands, query]);

  // Reset on open
  useEffect(() => {
    if (open) {
      setQuery("");
      setHighlight(0);
      setTimeout(() => inputRef.current?.focus(), 50);
    }
  }, [open]);

  // Reset highlight when filter changes
  useEffect(() => { setHighlight(0); }, [query]);

  // Keyboard nav
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") { onClose(); return; }
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setHighlight((h) => Math.min(h + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setHighlight((h) => Math.max(h - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const cmd = filtered[highlight];
        if (cmd) {
          cmd.action();
          onClose();
        }
      }
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, filtered, highlight, onClose]);

  // Group rendered list with separators
  const grouped: { group: string; items: Command[] }[] = [];
  filtered.forEach((c) => {
    const last = grouped[grouped.length - 1];
    if (last && last.group === c.group) last.items.push(c);
    else grouped.push({ group: c.group, items: [c] });
  });

  let runningIdx = 0;

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[60] flex items-start justify-center pt-[20vh] px-4">
          <motion.div
            className="absolute inset-0 bg-black/40"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          />
          <motion.div
            className="relative w-full max-w-xl rounded-2xl material-thick shadow-float border overflow-hidden"
            initial={{ opacity: 0, scale: 0.94, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4 }}
            transition={{ type: "spring", stiffness: 420, damping: 30, mass: 0.7 }}
          >
        {/* Search input */}
        <div className="flex items-center gap-3 px-4 h-14 border-b border-[var(--material-border)]">
          <Search size={16} className="text-text-muted shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Cerca un comando o una nota…"
            className="flex-1 bg-transparent border-none outline-none text-[15px] text-text-primary placeholder:text-text-faint"
          />
          <span className="font-mono text-[10px] text-text-faint border border-[var(--material-border)] rounded px-1.5 py-0.5">ESC</span>
        </div>

        {/* List */}
        <div className="max-h-[50vh] overflow-y-auto py-2">
          {filtered.length === 0 ? (
            <div className="px-4 py-8 text-center text-text-faint text-sm">Nessun risultato</div>
          ) : (
            grouped.map(({ group, items }) => (
              <div key={group} className="mb-1">
                <div className="px-4 pt-2 pb-1 text-[10px] font-semibold uppercase tracking-widest text-text-faint">
                  {group}
                </div>
                {items.map((c) => {
                  const idx = runningIdx++;
                  const isActive = idx === highlight;
                  return (
                    <button
                      key={c.id}
                      onMouseEnter={() => setHighlight(idx)}
                      onClick={() => { c.action(); onClose(); }}
                      className={`w-full flex items-center gap-3 px-4 py-2.5 text-left transition-colors ${
                        isActive ? "bg-surface-3/80" : "hover:bg-surface-2/40"
                      }`}
                    >
                      <span className={`shrink-0 ${isActive ? "text-accent" : "text-text-muted"}`}>{c.icon}</span>
                      <span className={`flex-1 text-[14px] truncate ${isActive ? "text-text-emphasis font-medium" : "text-text-primary"}`}>
                        {c.label}
                      </span>
                      {c.hint && (
                        <span className="text-[11px] text-text-faint font-mono">{c.hint}</span>
                      )}
                    </button>
                  );
                })}
              </div>
            ))
          )}
        </div>

            <div className="px-4 py-2 border-t border-[var(--material-border)] flex items-center gap-3 text-[10px] text-text-faint font-mono">
              <span>↑↓ naviga</span>
              <span>↵ apri</span>
              <span className="ml-auto">⌘K togli</span>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
