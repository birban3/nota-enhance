"use client";

import { Plus, Trash2, X, Search, Pin, PinOff, LogOut } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { ThemeToggle } from "./ThemeToggle";

export interface AskMsg { role: "user" | "assistant"; content: string; }

export interface ArchivedNote {
  id: string;
  title: string;
  notes: string;
  transcript: string;
  enhancedHtml: string;
  createdAt: number;
  updatedAt: number;
  manualTitle?: boolean;
  /** When true, the note appears at the top of the sidebar in a pinned section. */
  pinned?: boolean;
  /** Per-note horizontal split between Notes and Enhanced (0.15..0.85). */
  splitRatio?: number;
  /** Persisted Ask AI conversation for this note. Survives reload. */
  askMessages?: AskMsg[];
}

interface Props {
  notes: ArchivedNote[];
  activeId: string | null;
  open: boolean;
  onClose: () => void;
  onSelect: (id: string) => void;
  onCreate: () => void;
  onDelete: (id: string) => void;
  onTogglePin: (id: string) => void;
  onOpenCommandPalette: () => void;
  onLogout: () => void;
  username?: string | null;
  onMouseEnter?: () => void;
  onMouseLeave?: () => void;
}

function formatDate(ts: number): string {
  const d = new Date(ts);
  const today = new Date();
  const sameDay = d.toDateString() === today.toDateString();
  if (sameDay) {
    return d.toLocaleTimeString("it-IT", { hour: "2-digit", minute: "2-digit" });
  }
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  if (d.toDateString() === yesterday.toDateString()) return "Ieri";
  return d.toLocaleDateString("it-IT", { day: "2-digit", month: "short" });
}

function snippet(notesMd: string): string {
  const stripped = notesMd
    .replace(/^#+\s*/gm, "")
    .replace(/^[-*]\s*/gm, "")
    .replace(/\*\*/g, "")
    .replace(/^>\s*/gm, "")
    .replace(/\n+/g, " ")
    .trim();
  return stripped.slice(0, 70);
}

export function NotesSidebar({
  notes, activeId, open, onClose, onSelect, onCreate, onDelete, onTogglePin, onOpenCommandPalette, onLogout, username, onMouseEnter, onMouseLeave,
}: Props) {
  // Pinned first (within each group: most recent createdAt on top).
  const sorted = [...notes].sort((a, b) => {
    const ap = a.pinned ? 1 : 0;
    const bp = b.pinned ? 1 : 0;
    if (ap !== bp) return bp - ap;
    return b.createdAt - a.createdAt;
  });
  const [query, setQuery] = useState("");
  const [deleteConfirmId, setDeleteConfirmId] = useState<string | null>(null);
  const asideRef = useRef<HTMLElement>(null);

  // Close on Escape
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  const filtered = query.trim()
    ? sorted.filter((n) => {
        const q = query.toLowerCase();
        return (
          n.title.toLowerCase().includes(q) ||
          n.notes.toLowerCase().includes(q) ||
          n.transcript.toLowerCase().includes(q)
        );
      })
    : sorted;

  const handleMouseLeave = () => {
    if (!deleteConfirmId && onMouseLeave) onMouseLeave();
  };

  return (
    <AnimatePresence>
      {open && (
        <>
          {/* Subtle backdrop — not full opacity, just slight darken to focus the sidebar */}
          <motion.div
            onClick={onClose}
            onMouseEnter={handleMouseLeave}
            className="fixed inset-0 z-40 bg-black/10"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          />

          <motion.aside
            ref={asideRef}
            className="fixed top-2 bottom-2 left-2 right-2 md:top-3 md:left-3 md:bottom-3 md:right-auto md:w-72 z-50 rounded-2xl material-thick shadow-float border flex flex-col overflow-hidden pt-safe"
            initial={{ opacity: 0, x: -16, scale: 0.98 }}
            animate={{ opacity: 1, x: 0, scale: 1 }}
            exit={{ opacity: 0, x: -16, scale: 0.98 }}
            transition={{ type: "spring", stiffness: 380, damping: 32, mass: 0.7 }}
            onMouseEnter={onMouseEnter}
            onMouseLeave={handleMouseLeave}
          >
        {/* Header */}
        <div className="px-4 pt-4 pb-3 flex items-center justify-between gap-2">
          <span className="text-[13px] font-semibold text-text-primary tracking-tight">
            Le mie note
          </span>
          <div className="flex items-center gap-1.5">
            <button
              onClick={onCreate}
              title="Nuova nota"
              className="press w-9 h-9 md:w-8 md:h-8 flex items-center justify-center rounded-full bg-surface-3/50 hover:bg-accent text-text-secondary hover:text-white"
            >
              <Plus size={14} strokeWidth={2.5} />
            </button>
            {/* Mobile-only close button — desktop closes via hover-out / Esc / backdrop. */}
            <button
              onClick={onClose}
              title="Chiudi"
              className="md:hidden press w-9 h-9 flex items-center justify-center rounded-full bg-surface-2/60 text-text-secondary hover:text-text-primary"
            >
              <X size={16} />
            </button>
          </div>
        </div>

        {/* Search */}
        <div className="px-3 pb-2">
          <div className="flex items-center gap-2 h-9 px-3 rounded-lg bg-surface-2/60 border border-[var(--material-border)]">
            <Search size={13} className="text-text-faint shrink-0" />
            <input
              type="text"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Cerca…"
              className="flex-1 bg-transparent border-none outline-none text-[13px] text-text-primary placeholder:text-text-faint min-w-0"
            />
            {query && (
              <button onClick={() => setQuery("")} className="text-text-faint hover:text-text-primary">
                <X size={12} />
              </button>
            )}
          </div>
        </div>

        {/* List */}
        <div className="flex-1 overflow-y-auto px-2 pb-2">
          {filtered.length === 0 ? (
            <div className="px-3 py-8 text-[12px] text-text-faint leading-relaxed text-center">
              {query ? "Nessun risultato." : "Nessuna nota."}
            </div>
          ) : (
            <motion.ul
              className="space-y-0.5"
              initial="hidden"
              animate="visible"
              variants={{
                hidden: {},
                visible: { transition: { staggerChildren: 0.022, delayChildren: 0.04 } },
              }}
            >
              {filtered.map((n) => {
                const isActive = n.id === activeId;
                return (
                  <motion.li
                    key={n.id}
                    onClick={() => onSelect(n.id)}
                    variants={{
                      hidden: { opacity: 0, y: 6 },
                      visible: { opacity: 1, y: 0, transition: { type: "spring", stiffness: 420, damping: 30 } },
                    }}
                    whileTap={{ scale: 0.98 }}
                    className={`group px-3 py-2.5 cursor-pointer rounded-xl flex items-start gap-2 transition-colors ${
                      isActive
                        ? "bg-surface-3/80 shadow-soft"
                        : "hover:bg-surface-2/60"
                    }`}
                  >
                    <div className="flex-1 min-w-0">
                      <div className={`text-[13px] truncate font-medium flex items-center gap-1.5 ${isActive ? "text-text-emphasis" : "text-text-secondary"}`}>
                        {n.pinned && <Pin size={10} className="shrink-0 text-accent fill-accent rotate-45" />}
                        <span className="truncate">{n.title || "Senza titolo"}</span>
                      </div>
                      {n.notes && (
                        <div className="text-[11px] text-text-faint truncate mt-0.5">
                          {snippet(n.notes)}
                        </div>
                      )}
                      <div className="text-[10px] text-text-faint font-mono mt-1">
                        {formatDate(n.createdAt)}
                      </div>
                    </div>
                    <div className="flex items-center self-center gap-0.5">
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          onTogglePin(n.id);
                        }}
                        className={`${n.pinned ? "opacity-100 text-accent" : "opacity-0 group-hover:opacity-100 text-text-faint hover:text-accent"} transition-all p-1`}
                        title={n.pinned ? "Sblocca dalla cima" : "Pinna in cima"}
                      >
                        {n.pinned ? <PinOff size={13} /> : <Pin size={13} />}
                      </button>
                      <button
                        onClick={(e) => {
                          e.stopPropagation();
                          setDeleteConfirmId(n.id);
                        }}
                        className="opacity-0 group-hover:opacity-100 text-text-faint hover:text-rec transition-all p-1"
                        title="Elimina"
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </motion.li>
                );
              })}
            </motion.ul>
          )}
        </div>

        {/* Footer — Comandi pill (with explicit ⌘+K hint), logout, theme.
            The gear that opened the shortcuts modal lived here too but
            we removed it: settings stay reachable via the command palette
            entry "Scorciatoie & impostazioni" and the keyboard shortcut. */}
        <div className="px-3 py-3 border-t border-[var(--material-border)] flex items-center gap-2">
          <button
            onClick={() => { onClose(); onOpenCommandPalette(); }}
            className="press flex-1 flex items-center gap-2 h-9 px-3 rounded-lg bg-surface-2/50 hover:bg-surface-3/70 text-text-secondary hover:text-text-primary text-[12px] font-medium"
            title="Apri command palette"
          >
            <span className="font-mono text-text-faint">⌘+K</span>
            <span>Comandi</span>
          </button>
          <button
            onClick={onLogout}
            title={username ? `Esci (${username})` : "Esci"}
            className="press w-9 h-9 flex items-center justify-center rounded-lg bg-surface-2/50 hover:bg-rec/15 text-text-secondary hover:text-rec"
          >
            <LogOut size={14} />
          </button>
          <div className="shrink-0">
            <ThemeToggle compact />
          </div>
        </div>
      </motion.aside>

      {/* Delete Confirmation Modal */}
      <AnimatePresence>
        {deleteConfirmId && (
          <div className="fixed inset-0 z-[60] flex items-center justify-center px-4">
            <motion.div
              className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
              onClick={() => setDeleteConfirmId(null)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            />
            <motion.div
              className="relative w-full max-w-sm rounded-2xl material-thick shadow-float border p-5 overflow-hidden"
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 4 }}
              transition={{ type: "spring", stiffness: 420, damping: 30 }}
            >
              <h3 className="text-[15px] font-semibold text-text-emphasis tracking-tight mb-2">Elimina nota</h3>
              <p className="text-[13px] text-text-secondary leading-relaxed mb-6">
                Sei sicuro di voler eliminare definitivamente &quot;<span className="font-medium text-text-primary">{notes.find(n => n.id === deleteConfirmId)?.title || "questa nota"}</span>&quot;?
                Questa azione non può essere annullata.
              </p>
              <div className="flex items-center justify-end gap-3 mt-4">
                <button
                  onClick={() => setDeleteConfirmId(null)}
                  className="press px-4 py-2 rounded-xl text-[13px] font-medium text-text-muted hover:text-text-primary hover:bg-surface-3/60 transition-colors"
                >
                  Annulla
                </button>
                <button
                  onClick={() => {
                    onDelete(deleteConfirmId);
                    setDeleteConfirmId(null);
                  }}
                  className="press px-4 py-2 rounded-xl text-[13px] font-medium border border-rec/20 bg-rec/10 text-rec hover:bg-rec hover:text-white transition-colors shadow-sm"
                >
                  Elimina definitivamente
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

        </>
      )}
    </AnimatePresence>
  );
}
