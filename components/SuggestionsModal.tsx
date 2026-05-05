"use client";

import { useEffect, useState, FormEvent } from "react";
import { AnimatePresence, motion } from "framer-motion";
import { X, MessageCircle, Sparkles, Check, Loader2 } from "lucide-react";

interface Props {
  open: boolean;
  onClose: () => void;
}

const TEXT_MIN = 5;
const TEXT_MAX = 4000;
const CONTACT_MAX = 200;

// Lightweight modal for users to send improvement suggestions to the team.
// Mirrors SettingsModal in chrome — same header rule, same rounded-2xl card,
// same backdrop fade — so it feels like part of the app rather than an
// external form.
export function SuggestionsModal({ open, onClose }: Props) {
  const [text, setText] = useState("");
  const [contact, setContact] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  // Esc closes — matches the SettingsModal contract so users have one
  // muscle memory across modals.
  useEffect(() => {
    if (!open) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [open, onClose]);

  // Reset form state when the modal closes — without this a user reopening
  // the modal after submitting still sees the success screen instead of a
  // fresh form.
  useEffect(() => {
    if (open) return;
    const t = setTimeout(() => {
      setText("");
      setContact("");
      setError(null);
      setDone(false);
      setSubmitting(false);
    }, 200);
    return () => clearTimeout(t);
  }, [open]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    const body = text.trim();
    if (body.length < TEXT_MIN) {
      setError(`Scrivi almeno ${TEXT_MIN} caratteri.`);
      return;
    }
    if (body.length > TEXT_MAX) {
      setError(`Massimo ${TEXT_MAX} caratteri.`);
      return;
    }
    setSubmitting(true);
    try {
      const res = await fetch("/api/suggestions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: body, contact: contact.trim() || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        setError(data.error || "Errore durante l'invio.");
        return;
      }
      setDone(true);
    } catch {
      setError("Errore di rete.");
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <AnimatePresence>
      {open && (
        <div className="fixed inset-0 z-[65] flex items-end md:items-center justify-center md:px-4">
          <motion.div
            className="absolute inset-0 bg-black/50"
            onClick={onClose}
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
          />
          <motion.div
            className="relative w-full max-w-lg max-h-[92vh] md:max-h-none rounded-t-2xl md:rounded-2xl material-thick shadow-float md:border overflow-hidden flex flex-col pb-safe"
            initial={{ opacity: 0, scale: 0.94, y: -8 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.96, y: -4 }}
            transition={{ type: "spring", stiffness: 420, damping: 30, mass: 0.7 }}
          >
            {/* Header */}
            <div className="px-4 md:px-5 h-14 border-b border-[var(--material-border)] flex items-center gap-3 shrink-0">
              <MessageCircle size={16} className="text-text-muted" />
              <span className="text-[14px] font-semibold text-text-emphasis tracking-tight">
                Suggerisci un miglioramento
              </span>
              <div className="flex-1" />
              <button
                onClick={onClose}
                className="press w-9 h-9 md:w-8 md:h-8 flex items-center justify-center rounded-lg hover:bg-surface-3/60 text-text-muted hover:text-text-primary"
              >
                <X size={16} />
              </button>
            </div>

            {/* Body */}
            {done ? (
              <div className="p-8 flex flex-col items-center text-center gap-3">
                <div className="w-12 h-12 rounded-2xl bg-accent/15 border border-accent/25 flex items-center justify-center">
                  <Check size={20} className="text-accent" />
                </div>
                <div className="text-[14px] font-medium text-text-emphasis">
                  Grazie per il suggerimento!
                </div>
                <p className="text-[12.5px] text-text-secondary leading-relaxed max-w-xs">
                  Lo leggiamo e usiamo per dare priorità ai prossimi
                  miglioramenti. Se hai lasciato un contatto, magari ti
                  scriviamo.
                </p>
                <button
                  onClick={onClose}
                  className="press mt-2 h-9 px-4 rounded-lg text-[13px] font-medium bg-surface-2/60 hover:bg-surface-3/70 text-text-primary border border-[var(--material-border)]"
                >
                  Chiudi
                </button>
              </div>
            ) : (
              <form onSubmit={submit} className="p-4 md:p-5 space-y-3 flex-1 overflow-y-auto">
                <p className="text-[12.5px] text-text-secondary leading-relaxed">
                  Cosa vorresti che funzionasse meglio? Cosa manca? Cosa è confuso?
                  Ogni suggerimento viene letto.
                </p>
                <textarea
                  value={text}
                  onChange={(e) => setText(e.target.value)}
                  placeholder="Es. mi piacerebbe poter…"
                  rows={6}
                  maxLength={TEXT_MAX}
                  required
                  className="w-full bg-surface-2/60 border border-[var(--material-border)] focus:border-accent/40 rounded-xl outline-none px-3 py-2.5 text-[13px] text-text-primary placeholder:text-text-muted/60 transition-colors resize-y leading-relaxed"
                />
                <div className="flex items-center justify-between text-[10.5px] text-text-faint font-mono">
                  <span>min {TEXT_MIN} · max {TEXT_MAX}</span>
                  <span className={text.length > TEXT_MAX * 0.9 ? "text-rec" : undefined}>
                    {text.length}/{TEXT_MAX}
                  </span>
                </div>
                <div className="space-y-1.5">
                  <label className="text-[11.5px] text-text-muted font-medium">
                    Contatto (opzionale)
                  </label>
                  <input
                    type="text"
                    value={contact}
                    onChange={(e) => setContact(e.target.value)}
                    placeholder="Email o handle, se vuoi che ti rispondiamo"
                    maxLength={CONTACT_MAX}
                    className="w-full bg-surface-2/60 border border-[var(--material-border)] focus:border-accent/40 rounded-xl outline-none px-3 py-2 text-[13px] text-text-primary placeholder:text-text-muted/60 transition-colors"
                  />
                </div>

                {error && (
                  <div className="text-[12px] text-rec bg-rec/10 border border-rec/25 rounded-lg px-3 py-2">
                    {error}
                  </div>
                )}

                <div className="flex items-center justify-end gap-2 pt-1">
                  <button
                    type="button"
                    onClick={onClose}
                    className="press h-9 px-4 rounded-lg text-[13px] font-medium text-text-secondary hover:text-text-primary"
                  >
                    Annulla
                  </button>
                  <button
                    type="submit"
                    disabled={submitting}
                    className="btn-premium-accent press h-9 px-4 rounded-lg text-[13px] font-medium tracking-tight inline-flex items-center gap-1.5 disabled:opacity-50"
                  >
                    {submitting ? (
                      <Loader2 size={13} className="animate-spin-fast" />
                    ) : (
                      <Sparkles size={13} />
                    )}
                    Invia
                  </button>
                </div>
              </form>
            )}
          </motion.div>
        </div>
      )}
    </AnimatePresence>
  );
}
