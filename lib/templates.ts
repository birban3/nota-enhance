"use client";

/**
 * Enhance templates — reusable "context / instructions" snippets the user
 * picks (or writes) before running an Enhance. There are two sources:
 *
 *   • DEFAULT_TEMPLATES — shipped with the app, always present, not deletable.
 *   • Custom templates  — created by the user, persisted in localStorage so
 *     they survive reloads on this device.
 *
 * The combined list is shown as chips in the Enhance prompt modal; clicking a
 * chip drops its `content` into the instructions textarea. The user can also
 * save whatever they've typed as a new custom template.
 */

export interface EnhanceTemplate {
  id: string;
  name: string;
  content: string;
  /** true for built-in templates — they can't be deleted from the UI. */
  builtin?: boolean;
}

export const DEFAULT_TEMPLATES: EnhanceTemplate[] = [
  {
    id: "builtin-schema",
    name: "Riassunto schematico",
    content:
      "Riorganizza in un riassunto schematico con titoli, sottotitoli ed elenchi puntati delle idee principali. Mantieni un tono chiaro e ordinato.",
    builtin: true,
  },
  {
    id: "builtin-definizioni",
    name: "Definizioni chiave",
    content:
      "Estrai e spiega in una lista i termini e le definizioni chiave presenti negli appunti, una voce per termine.",
    builtin: true,
  },
  {
    id: "builtin-ripasso",
    name: "Domande di ripasso",
    content:
      "Genera una lista di domande di ripasso con le relative risposte, basate esclusivamente sul contenuto degli appunti.",
    builtin: true,
  },
  {
    id: "builtin-mappa",
    name: "Mappa concettuale",
    content:
      "Organizza i contenuti in una struttura gerarchica tipo mappa concettuale: concetto principale, sottoconcetti e collegamenti tra loro.",
    builtin: true,
  },
];

const STORAGE_KEY = "nota-enhance-templates";

export function loadCustomTemplates(): EnhanceTemplate[] {
  if (typeof window === "undefined") return [];
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.filter(
      (t): t is EnhanceTemplate =>
        !!t &&
        typeof t === "object" &&
        typeof (t as EnhanceTemplate).id === "string" &&
        typeof (t as EnhanceTemplate).name === "string" &&
        typeof (t as EnhanceTemplate).content === "string"
    );
  } catch {
    return [];
  }
}

function saveCustomTemplates(list: EnhanceTemplate[]): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list));
  } catch {}
}

/** The full list shown in the UI: built-ins first, then custom ones. */
export function loadAllTemplates(): EnhanceTemplate[] {
  return [...DEFAULT_TEMPLATES, ...loadCustomTemplates()];
}

/** Append a new custom template, returning the updated custom list. */
export function addCustomTemplate(name: string, content: string): EnhanceTemplate[] {
  const next = loadCustomTemplates();
  next.push({
    id: "custom-" + Date.now().toString(36) + Math.random().toString(36).slice(2, 6),
    name: name.trim() || "Template",
    content: content.trim(),
  });
  saveCustomTemplates(next);
  return next;
}

/** Delete a custom template by id (built-ins are ignored). */
export function deleteCustomTemplate(id: string): EnhanceTemplate[] {
  const next = loadCustomTemplates().filter((t) => t.id !== id);
  saveCustomTemplates(next);
  return next;
}
