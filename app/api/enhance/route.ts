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

// Strip prefixes we know the model emits at the start of the title
const TITLE_PREFIX_RE = /^(note\s+enhanced|note\s+migliorate|riassunto(\s+strutturato)?|note\s+rielaborate|enhanced\s+notes?)\s*[:\-—]\s*/i;

function extractTitle(md: string): string {
  for (const line of md.split("\n")) {
    const t = line.trim();
    if (!t) continue;
    // First heading of any level → strip the # markers
    const heading = t.match(/^#{1,3}\s+(.+)$/);
    if (heading) {
      let title = heading[1].replace(/\*\*/g, "").trim();
      title = title.replace(TITLE_PREFIX_RE, "").trim();
      if (title) return title.length > 60 ? title.slice(0, 60) + "…" : title;
    }
    // No heading found → use first non-empty line, stripped
    let title = t.replace(/^[-*]\s*/, "").replace(/\*\*/g, "").replace(/^>\s*/, "").trim();
    title = title.replace(TITLE_PREFIX_RE, "").trim();
    if (title) return title.length > 60 ? title.slice(0, 60) + "…" : title;
  }
  // Always-on fallback: a dated generic title so the client never gets null.
  const now = new Date();
  return `Nota ${now.toLocaleDateString("it-IT", { day: "2-digit", month: "short" })}`;
}

export async function POST(req: NextRequest) {
  try {
    if (!process.env.OPENROUTER_API_KEY) {
      return NextResponse.json(
        { error: "OPENROUTER_API_KEY non configurata in .env.local" },
        { status: 500 }
      );
    }

    const payload = await req.json();
    const notes = payload.notes || "";
    const transcript = payload.transcript || "";
    const instructions = payload.instructions || "";

    if (!notes && !transcript) {
      return NextResponse.json({ error: "No content provided" }, { status: 400 });
    }

    const hasNotes = !!notes?.trim();
    const hasTranscript = !!transcript?.trim();

    let prompt: string;

    if (hasNotes && hasTranscript) {
      prompt = `Sei un assistente accademico. Ti vengono fornite note scritte durante una lezione e la trascrizione audio della stessa lezione. Entrambe le fonti possono essere incomplete o imprecise: le note possono perdere dettagli, la trascrizione può contenere errori di riconoscimento o non captare cose dette piano.

Produci una versione ENHANCED delle note seguendo queste regole di gestione delle informazioni:

1. **Informazioni presenti in una sola fonte** → includile (sia che vengano solo dalle note, sia che vengano solo dalla trascrizione). Non scartare mai contenuto unilaterale.

2. **Informazioni che possono COESISTERE** (es. "Marco è biondo" nelle note + "Marco è alto" nella trascrizione → sono fatti indipendenti, entrambi plausibili) → **sommale entrambe**. Segnala con una nota a piè di voce — formato: \`> ℹ️ Aggiunta dalla trascrizione: ...\` oppure \`> ℹ️ Aggiunta dalle note: ...\` — quale fonte ha contribuito quale dettaglio.

3. **Informazioni in CONFLITTO DIRETTO** (es. "Marco è biondo" vs "Marco è moro" → non possono essere entrambe vere) → **dai maggiore credibilità alla trascrizione audio** (è la registrazione della lezione), MA segnala sempre la discrepanza in modo visibile, formato: \`> ⚠️ Discrepanza: le note dicono "X", la trascrizione dice "Y". Riportato il valore della trascrizione — verifica tu.\` — così lo studente ha la decisione finale.

4. **Distinguere coesistenza da conflitto richiede giudizio**: due affermazioni sono in conflitto solo se logicamente non possono essere entrambe vere insieme. In dubbio, trattale come coesistenti e segnala.

Altre regole:
- Mantieni lo stile e il tono delle note originali come struttura portante
- Correggi errori grammaticali e di battitura nelle note (questi NON vanno segnalati come discrepanze)
- Se il testo sorgente è molto breve o contiene solo fatti diretti (es. una sola frase), REPLICALO a livello fattuale: ASSOLUTAMENTE VIETATO aggiungere sezioni di "osservazioni", metadati, analisi, conclusioni o verbosità inutile. Mantienilo super conciso e limitati ai nudi fatti esposti.
- INIZIA SEMPRE con un titolo H2 conciso (max 6 parole) che rappresenti l'argomento principale. NON usare prefissi come "Note Enhanced:", "Riassunto:", ecc. — solo il titolo del contenuto.
- Usa heading markdown (##, ###) per organizzare le sezioni (solo se il testo è sufficientemente lungo)
- Usa "- " per i punti elenco
- Usa **grassetto** per concetti chiave
- Le note di segnalazione (ℹ️ / ⚠️) usano la sintassi blockquote markdown (\`> \`)

NOTE SCRITTE:
${notes}

TRASCRIZIONE AUDIO:
${transcript}

${instructions ? `ISTRUZIONI AGGIUNTIVE DELL'UTENTE:\n"${instructions}"\nAttieniti scrupolosamente a queste istruzioni aggiuntive assieme alle tue istruzioni base.` : ""}

Produci le note enhanced in italiano, formato markdown.`;
    } else if (hasNotes) {
      prompt = `Sei un assistente accademico. Ti vengono fornite note scritte durante una lezione.

Migliorale:
- INIZIA SEMPRE con un titolo H2 conciso (max 6 parole) che rappresenti l'argomento principale. NON usare prefissi come "Note Enhanced:" o simili.
- Correggi errori grammaticali e di battitura
- Migliora la struttura e l'organizzazione
- Se la nota è molto breve (es. una singola riga o dato fattuale), limitati a trasciverla pulita. È SEVERAMENTE VIETATO aggiungere sezioni come "Osservazioni", commenti sul tono del testo, recap generali o paragrafi di riempimento. Restituisci SOLO l'informazione fornita.
- Rendi i concetti più chiari
- Non inventare contenuti non presenti nelle note originali
- Usa heading markdown (##, ###) per organizzare le sezioni (solo se necessario per la lunghezza)
- Usa "- " per i punti elenco
- Usa **grassetto** per concetti chiave

NOTE SCRITTE:
${notes}

${instructions ? `ISTRUZIONI AGGIUNTIVE DELL'UTENTE:\n"${instructions}"\nAttieniti scrupolosamente a queste istruzioni aggiuntive assieme alle tue istruzioni base.` : ""}

Produci le note migliorate in italiano, formato markdown.`;
    } else {
      prompt = `Sei un assistente accademico. Ti viene fornita la trascrizione audio di una lezione.

Produci un riassunto strutturato:
- INIZIA SEMPRE con un titolo H2 conciso (max 6 parole) che rappresenti l'argomento principale. NON usare prefissi come "Riassunto:" o simili.
- Se l'audio è brevissimo (es. una sola frase o concetto), trascrivi solo il punto essenziale in modo diretto. VIETATO creare sezioni inutili come "Osservazioni", commenti e metadati.
- Organizza per argomenti principali (se adeguatamente lungo)
- Evidenzia i punti chiave
- Usa heading markdown (##, ###) per le sezioni
- Usa "- " per i punti elenco
- Usa **grassetto** per concetti chiave

TRASCRIZIONE AUDIO:
${transcript}

${instructions ? `ISTRUZIONI AGGIUNTIVE DELL'UTENTE:\n"${instructions}"\nAttieniti scrupolosamente a queste istruzioni aggiuntive assieme alle tue istruzioni base.` : ""}

Produci il riassunto in italiano, formato markdown.`;
    }

    // Provider routing: prefer fast/reliable providers, fallback automatically.
    // "sort: throughput" tells OpenRouter to pick the highest-throughput provider.
    const providerRouting = process.env.OPENROUTER_PROVIDER
      ? { only: [process.env.OPENROUTER_PROVIDER] }
      : { sort: "throughput" as const };

    // No max_tokens cap — let the provider stream the full response.
    // DeepSeek V4 Flash supports very long completions; capping at 4096 was
    // truncating long lecture summaries. We rely on the model's native context.
    
    // We must extract actual Base64 Image URLs from the markdown and supply them
    // to the AI using native multimodal JSON formatting, otherwise the LLM will see 
    // the Base64 as literal text and hallucinate or crash the context window.
    const images: string[] = [];
    const finalPromptText = prompt.replace(/!\[.*?\]\((data:image\/[^;]+;base64,[^)]+)\)/g, (match, url) => {
      images.push(url);
      return "[🖼️ Immagine fornita all'AI come allegato visivo]";
    });

    const content: any[] = [{ type: "text" as const, text: finalPromptText }];
    for (const url of images) {
      content.push({ type: "image_url" as const, image_url: { url } });
    }

    const requestBody = {
      model: MODEL,
      messages: [{ role: "user" as const, content }],
    };

    // Helper: single retry on 429
    let completion;
    let lastError: unknown = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        completion = await client.chat.completions.create({
          ...requestBody,
          // @ts-expect-error OpenRouter-specific provider routing field
          provider: providerRouting,
        });
        break;
      } catch (err: unknown) {
        lastError = err;
        const status = (err as { status?: number })?.status;
        if (status === 429 && attempt === 0) {
          // back off and retry once
          await new Promise((r) => setTimeout(r, 2500));
          continue;
        }
        throw err;
      }
    }
    if (!completion) throw lastError;

    // Defensive: provider may return malformed payload
    const choices = (completion as { choices?: unknown[] }).choices;
    if (!Array.isArray(choices) || choices.length === 0) {
      console.error("Empty choices from provider:", JSON.stringify(completion).slice(0, 500));
      return NextResponse.json(
        { error: "Il provider ha restituito una risposta vuota. Riprova." },
        { status: 502 }
      );
    }
    const text = (choices[0] as { message?: { content?: string } })?.message?.content ?? "";
    if (!text) {
      return NextResponse.json(
        { error: "Risposta del modello vuota. Riprova." },
        { status: 502 }
      );
    }

    return NextResponse.json({
      enhanced: text,
      title: extractTitle(text),
    });
  } catch (err: unknown) {
    console.error("Enhance API error:", err);
    const status = (err as { status?: number })?.status;
    const message = err instanceof Error ? err.message : "Unknown error";
    if (status === 429) {
      return NextResponse.json(
        { error: "Rate limit OpenRouter (429). Aspetta qualche secondo e riprova, oppure passa a un piano a pagamento." },
        { status: 429 }
      );
    }
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
