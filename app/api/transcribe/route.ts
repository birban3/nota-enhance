import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";

// Groq Whisper — OpenAI-compatible, free tier generoso, veloce.
// Get a key at https://console.groq.com/keys
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const MODEL = process.env.GROQ_TRANSCRIBE_MODEL ?? "whisper-large-v3-turbo";

// Aumenta il limite del body Next.js per file audio grandi
export const runtime = "nodejs";
export const maxDuration = 60;

export async function POST(req: NextRequest) {
  try {
    if (!process.env.GROQ_API_KEY) {
      return NextResponse.json(
        { error: "GROQ_API_KEY non configurata. Aggiungila in .env.local." },
        { status: 500 }
      );
    }

    const formData = await req.formData();
    const file = formData.get("audio");
    if (!file || !(file instanceof Blob)) {
      return NextResponse.json({ error: "File audio mancante" }, { status: 400 });
    }

    // Convert Blob to File-like object that the SDK accepts
    const filename = (file as File).name || "audio.webm";
    const audioFile = new File([file], filename, { type: file.type || "audio/webm" });

    const transcription = await client.audio.transcriptions.create({
      file: audioFile,
      model: MODEL,
      language: "it",
      response_format: "text",
    });

    // response_format=text returns a plain string
    const text = typeof transcription === "string"
      ? transcription
      : (transcription as { text?: string }).text ?? "";

    return NextResponse.json({ text });
  } catch (err: unknown) {
    console.error("Transcribe API error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
