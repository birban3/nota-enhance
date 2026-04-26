import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

const client = new OpenAI({
  apiKey: process.env.OPENROUTER_API_KEY,
  baseURL: "https://openrouter.ai/api/v1",
  defaultHeaders: {
    "HTTP-Referer": process.env.OPENROUTER_SITE_URL ?? "http://localhost:3000",
    "X-Title": process.env.OPENROUTER_SITE_NAME ?? "nota-enhance",
  },
});

const MODEL = process.env.OPENROUTER_MODEL ?? "deepseek/deepseek-v4-flash";

interface ChatMsg { role: "user" | "assistant"; content: string; }

export async function POST(req: NextRequest) {
  try {
    if (!process.env.OPENROUTER_API_KEY) {
      return NextResponse.json(
        { error: "OPENROUTER_API_KEY non configurata in .env.local" },
        { status: 500 }
      );
    }

    const { question, context, history } = await req.json();

    const q = typeof question === "string" ? question.trim() : "";
    const ctx = typeof context === "string" ? context.trim() : "";
    const hist: ChatMsg[] = Array.isArray(history) ? history.slice(-12) : [];

    if (!q) {
      return NextResponse.json({ error: "Domanda mancante." }, { status: 400 });
    }
    if (!ctx) {
      return NextResponse.json({ error: "Nessun contesto disponibile (serve nota enhanced o trascrizione)." }, { status: 400 });
    }

    const system = `Sei un assistente accademico. Rispondi alle domande dello studente usando ESCLUSIVAMENTE il contenuto fornito nel CONTESTO qui sotto.

Il contesto può contenere fino a due sezioni:
- "### NOTA ENHANCED": versione strutturata e curata della lezione (più affidabile per concetti chiave e organizzazione).
- "### TRASCRIZIONE COMPLETA": trascrizione audio integrale (può contenere dettagli, esempi e digressioni che non sono finiti nella nota enhanced).

Regole:
- Privilegia la NOTA ENHANCED per definizioni, struttura, concetti centrali. Usa la TRASCRIZIONE per recuperare dettagli, citazioni o passaggi che la nota non riporta.
- Se le due fonti sono in conflitto, indicalo brevemente e proponi la versione più probabile (di solito la nota enhanced ha già risolto il conflitto, ma se la trascrizione contiene un dettaglio chiaro che la nota omette, riportalo segnalandone la fonte).
- Se l'informazione non è in nessuna delle due fonti, dillo chiaramente ("Questa informazione non è presente nel contesto") invece di inventare.
- Rispondi in italiano, in modo conciso e diretto. Usa markdown leggero (grassetto, elenchi) solo se aiuta la chiarezza.
- Non ripetere alla lettera blocchi lunghi del contesto: sintetizza.

CONTESTO:
"""
${ctx}
"""`;

    const messages: { role: "system" | "user" | "assistant"; content: string }[] = [
      { role: "system", content: system },
      ...hist
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && typeof m.content === "string")
        .map((m) => ({ role: m.role, content: m.content })),
      { role: "user", content: q },
    ];

    const providerRouting = process.env.OPENROUTER_PROVIDER
      ? { only: [process.env.OPENROUTER_PROVIDER] }
      : { sort: "throughput" as const };

    const completion = await client.chat.completions.create({
      model: MODEL,
      messages,
      // @ts-expect-error OpenRouter-specific provider routing field
      provider: providerRouting,
    });

    const choices = (completion as { choices?: unknown[] }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      return NextResponse.json({ error: "Risposta vuota dal provider." }, { status: 502 });
    }
    const text = (choices[0] as { message?: { content?: string } })?.message?.content ?? "";
    if (!text) {
      return NextResponse.json({ error: "Risposta del modello vuota." }, { status: 502 });
    }

    return NextResponse.json({ answer: text });
  } catch (err: unknown) {
    console.error("Ask API error:", err);
    const status = (err as { status?: number })?.status;
    const message = err instanceof Error ? err.message : "Errore sconosciuto";
    if (status === 429) {
      return NextResponse.json(
        { error: "Rate limit OpenRouter (429). Aspetta qualche secondo e riprova." },
        { status: 429 }
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
