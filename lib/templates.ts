// User-created enhancement templates — saved instruction presets the user
// can reuse in the "give context before enhancing" modal.
//
// Stored per-user in users.enhance_templates (JSONB) so they sync across
// every device the user logs in on. Defaults (DEFAULT_TEMPLATES) are NOT
// stored here — the client always shows them; only user-created ones live
// in the DB. When Postgres isn't configured (dev without DATABASE_URL),
// reads return [] and writes are no-ops; the client keeps custom templates
// in localStorage as a fallback so the feature still works locally.
//
// Server-only.

import "server-only";
import { db, pgConfigured } from "@/lib/db";

export interface EnhanceTemplate {
  id: string;
  name: string;
  instructions: string;
}

// Built-in presets shown to everyone. Kept here so the client and any
// future server-side use share one source of truth (re-exported to the
// client via the API's `defaults`).
export const DEFAULT_TEMPLATES: EnhanceTemplate[] = [
  { id: "def-schema", name: "Riassunto schematico", instructions: "Riassumi in punti elenco chiari e gerarchici, evidenziando in grassetto i concetti chiave." },
  { id: "def-definizioni", name: "Definizioni chiave", instructions: "Estrai e spiega tutte le definizioni e i termini tecnici principali, una per riga." },
  { id: "def-esame", name: "Schema per esame", instructions: "Organizza il contenuto come schema di ripasso per un esame: titoli, sotto-punti e una sezione finale 'Da ricordare'." },
  { id: "def-domande", name: "Domande di verifica", instructions: "Mantieni il riassunto e, alla fine, aggiungi 5 domande di autoverifica con relative risposte." },
  { id: "def-discorsivo", name: "Discorsivo", instructions: "Riscrivi in forma discorsiva e scorrevole, mantenendo tutti i dettagli e i passaggi logici." },
];

const MAX_TEMPLATES = 30;
const NAME_MAX = 60;
const INSTR_MAX = 2000;

function sanitize(list: unknown): EnhanceTemplate[] {
  if (!Array.isArray(list)) return [];
  const out: EnhanceTemplate[] = [];
  for (const t of list) {
    if (!t || typeof t !== "object") continue;
    const id = typeof (t as EnhanceTemplate).id === "string" ? (t as EnhanceTemplate).id : "";
    const name = typeof (t as EnhanceTemplate).name === "string" ? (t as EnhanceTemplate).name.trim().slice(0, NAME_MAX) : "";
    const instructions = typeof (t as EnhanceTemplate).instructions === "string"
      ? (t as EnhanceTemplate).instructions.trim().slice(0, INSTR_MAX)
      : "";
    if (!id || !name || !instructions) continue;
    out.push({ id, name, instructions });
    if (out.length >= MAX_TEMPLATES) break;
  }
  return out;
}

export async function getUserTemplates(userId: string): Promise<EnhanceTemplate[]> {
  if (!userId || !pgConfigured()) return [];
  const client = await db();
  const uid = userId.trim().toLowerCase();
  const rows = (await client`SELECT enhance_templates FROM users WHERE id = ${uid}`) as Array<{
    enhance_templates: EnhanceTemplate[] | string | null;
  }>;
  const raw = rows[0]?.enhance_templates;
  if (!raw) return [];
  if (Array.isArray(raw)) return sanitize(raw);
  if (typeof raw === "string") {
    try { return sanitize(JSON.parse(raw)); } catch { return []; }
  }
  return [];
}

/** Replace the user's full custom-template list. Returns the sanitized list
 *  actually written (so the caller can echo it back to the client). No-op
 *  (returns the sanitized input) when PG isn't configured. */
export async function saveUserTemplates(
  userId: string,
  list: unknown
): Promise<EnhanceTemplate[]> {
  const clean = sanitize(list);
  if (!userId || !pgConfigured()) return clean;
  const client = await db();
  const uid = userId.trim().toLowerCase();
  await client`UPDATE users SET enhance_templates = ${JSON.stringify(clean)}::jsonb WHERE id = ${uid}`;
  return clean;
}
