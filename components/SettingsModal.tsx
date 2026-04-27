"use client";

import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X, RotateCcw, Keyboard } from "lucide-react";
import {
  DEFAULT_SHORTCUTS,
  SHORTCUT_LABELS,
  eventToShortcut,
  formatShortcut,
  type Shortcut,
  type ShortcutId,
} from "@/lib/shortcuts";

interface Props {
  open: boolean;
  onClose: () => void;
  shortcuts: Record<ShortcutId, Shortcut>;
  onChange: (next: Record<ShortcutId, Shortcut>) => void;
}

export function SettingsModal({ open, onClose, shortcuts, onChange }: Props) {
  const [recordingId, setRecordingId] = useState<ShortcutId | null>(null);

  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (recordingId) {
        e.preventDefault();
        e.stopPropagation();
        if (e.key === "Escape") {
          setRecordingId(null);
          return;
        }
        const s = eventToShortcut(e);
        if (!s) return;
        // Disallow plain non-modifier letters (would conflict with typing)
        if (!s.meta && !s.alt && s.key.length === 1) return;
        onChange({ ...shortcuts, [recordingId]: s });
        setRecordingId(null);
      } else if (e.key === "Escape") {
        onClose();
      }
    };
    document.addEventListener("keydown", handler, true);
    return () => document.removeEventListener("keydown", handler, true);
  }, [open, recordingId, shortcuts, onChange, onClose]);

  const ids = Object.keys(SHORTCUT_LABELS) as ShortcutId[];

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[65] flex items-end sm:items-center justify-center sm:px-4">
          <motion.div
            className="absolute inset-0 bg-black/50"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          />
          <motion.div
            className="relative w-full max-w-lg max-h-[92vh] sm:max-h-none rounded-t-2xl sm:rounded-2xl material-thick shadow-float sm:border overflow-hidden flex flex-col pb-safe"
            initial={{ opacity: 0, scale: 0.94, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4 }}
            transition={{ type: "spring", stiffness: 420, damping: 30, mass: 0.7 }}
          >
            {/* Header */}
            <div className="px-4 sm:px-5 h-14 border-b border-[var(--material-border)] flex items-center gap-3 shrink-0">
              <Keyboard size={16} className="text-text-muted" />
              <span className="text-[14px] font-semibold text-text-emphasis tracking-tight">
                Scorciatoie da tastiera
              </span>
              <div className="flex-1" />
              <button onClick={onClose} className="press w-9 h-9 sm:w-8 sm:h-8 flex items-center justify-center rounded-lg hover:bg-surface-3/60 text-text-muted hover:text-text-primary">
                <X size={16} />
              </button>
            </div>

            {/* Body */}
            <div className="p-3 flex-1 overflow-y-auto">
              <p className="text-[12px] text-text-muted px-2 pb-3 leading-relaxed">
                Clicca su una scorciatoia per riassegnarla. Premi <span className="font-mono text-text-secondary">Esc</span> per annullare.
              </p>
              <ul className="space-y-1">
                {ids.map((id) => {
                  const isRecording = recordingId === id;
                  const sc = shortcuts[id];
                  const isDefault = JSON.stringify(sc) === JSON.stringify(DEFAULT_SHORTCUTS[id]);
                  return (
                    <li
                      key={id}
                      className="flex items-center gap-3 px-3 py-2.5 rounded-xl hover:bg-surface-2/60 transition-colors"
                    >
                      <span className="flex-1 text-[13px] text-text-secondary">
                        {SHORTCUT_LABELS[id]}
                      </span>
                      <button
                        onClick={() => setRecordingId(id)}
                        className={`press min-w-[80px] h-8 px-3 rounded-lg font-mono text-[12px] transition-colors ${
                          isRecording
                            ? "bg-accent text-white border border-accent"
                            : "bg-surface-2/70 hover:bg-surface-3/80 text-text-primary border border-[var(--material-border)]"
                        }`}
                      >
                        {isRecording ? "Premi…" : formatShortcut(sc)}
                      </button>
                      {!isDefault && (
                        <button
                          onClick={() => onChange({ ...shortcuts, [id]: DEFAULT_SHORTCUTS[id] })}
                          title="Ripristina default"
                          className="press w-7 h-7 flex items-center justify-center rounded-lg text-text-faint hover:text-text-primary hover:bg-surface-3/50"
                        >
                          <RotateCcw size={12} />
                        </button>
                      )}
                    </li>
                  );
                })}
              </ul>

              <button
                onClick={() => onChange({ ...DEFAULT_SHORTCUTS })}
                className="press mt-3 w-full h-9 rounded-lg bg-surface-2/60 hover:bg-surface-3/70 text-text-secondary hover:text-text-primary text-[12px] font-medium border border-[var(--material-border)]"
              >
                Ripristina tutte le scorciatoie ai default
              </button>

              {/* Formatting Shortcuts */}
              <div className="mt-8 mb-2 px-2 flex items-center justify-between">
                <span className="text-[12px] font-semibold text-text-primary tracking-tight">Formattazione Editor</span>
                <span className="text-[9px] bg-surface-2 px-1.5 py-0.5 rounded text-text-faint uppercase tracking-widest font-semibold border border-[var(--material-border)]">Non modificabili</span>
              </div>
              <ul className="space-y-1 mb-2">
                {[
                  { label: "Grassetto", keys: "⌘ B", md: "**testo**" },
                  { label: "Corsivo", keys: "⌘ I", md: "*testo*" },
                  { label: "Sottolineato", keys: "⌘ U" },
                  { label: "Evidenziato", keys: "⌘ E" },
                  { label: "Titolo 1", keys: "⌘ ⌥ 1", md: "# " },
                  { label: "Titolo 2", keys: "⌘ ⌥ 2", md: "## " },
                  { label: "Titolo 3", keys: "⌘ ⌥ 3", md: "### " },
                  { label: "Elenco puntato", keys: "⌘ ⇧ 8", md: "- " },
                  { label: "Citazione", keys: "⌘ ⇧ B", md: "> " },
                ].map((s) => (
                  <li key={s.label} className="flex items-center gap-3 px-3 py-2 rounded-xl transition-colors">
                    <div className="flex-1 min-w-0 flex items-center gap-2">
                      <span className="text-[13px] text-text-secondary">{s.label}</span>
                      {s.md && (
                        <span className="text-[10px] text-text-faint bg-surface-2/50 border border-[var(--material-border)] px-1.5 py-[1px] rounded font-mono truncate">
                          scrivi {s.md}
                        </span>
                      )}
                    </div>
                    <div className="flex gap-1 shrink-0">
                      {s.keys.split(" ").map((k, i) => (
                        <span key={i} className="min-w-[22px] h-[22px] px-1.5 flex items-center justify-center rounded-md bg-surface-1 border border-[var(--material-border)] text-[11px] text-text-primary font-mono shadow-sm">
                          {k}
                        </span>
                      ))}
                    </div>
                  </li>
                ))}
              </ul>
            </div>
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
