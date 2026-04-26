import { NextRequest, NextResponse } from "next/server";
import OpenAI from "openai";
import { del } from "@vercel/blob";

// Groq Whisper — OpenAI-compatible, free tier generoso, veloce.
// Get a key at https://console.groq.com/keys
const client = new OpenAI({
  apiKey: process.env.GROQ_API_KEY,
  baseURL: "https://api.groq.com/openai/v1",
});

const MODEL = process.env.GROQ_TRANSCRIBE_MODEL ?? "whisper-large-v3-turbo";

export const runtime = "nodejs";
export const maxDuration = 60;

// The route accepts TWO upload modes:
//
//   1. Direct FormData ("audio" field).
//      Used in local dev (no body-size limit) and as a graceful fallback
//      when Vercel Blob isn't configured. Capped by the platform at ~4.5 MB
//      on Vercel.
//
//   2. JSON `{ url, filename, contentType }`.
//      Used in production: the client uploads the audio directly to Vercel
//      Blob first (no body limit), then POSTs only the resulting URL here.
//      We fetch the blob server-side, forward it to Groq, then delete it.
//
// The dispatcher inspects Content-Type to decide which mode is in play.

async function handleBlobUrl(url: string, filename: string, contentType?: string) {
  // Sanity: only accept Vercel Blob URLs to avoid this becoming an open
  // relay where attackers point us at arbitrary URLs.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("URL Blob non valido.");
  }
  if (!parsed.hostname.endsWith(".public.blob.vercel-storage.com")) {
    throw new Error("URL non riconosciuto come Vercel Blob.");
  }

  const fetched = await fetch(url);
  if (!fetched.ok) throw new Error(`Fetch del Blob fallito: ${fetched.status}`);
  const buf = await fetched.arrayBuffer();
  const file = new File([buf], filename || "audio.webm", {
    type: contentType || fetched.headers.get("content-type") || "audio/webm",
  });
  return file;
}

export async function POST(req: NextRequest) {
  try {
    if (!process.env.GROQ_API_KEY) {
      return NextResponse.json(
        { error: "GROQ_API_KEY non configurata." },
        { status: 500 }
      );
    }

    const contentType = req.headers.get("content-type") || "";
    let audioFile: File | null = null;
    let blobUrlToCleanup: string | null = null;

    if (contentType.includes("application/json")) {
      // Mode 2 — Blob URL handoff.
      const body = (await req.json()) as {
        url?: string;
        filename?: string;
        contentType?: string;
      };
      if (!body?.url) {
        return NextResponse.json({ error: "URL Blob mancante." }, { status: 400 });
      }
      audioFile = await handleBlobUrl(body.url, body.filename || "audio.webm", body.contentType);
      blobUrlToCleanup = body.url;
    } else {
      // Mode 1 — direct FormData upload.
      const formData = await req.formData();
      const file = formData.get("audio");
      if (!file || !(file instanceof Blob)) {
        return NextResponse.json({ error: "File audio mancante." }, { status: 400 });
      }
      const filename = (file as File).name || "audio.webm";
      audioFile = new File([file], filename, { type: file.type || "audio/webm" });
    }

    const transcription = await client.audio.transcriptions.create({
      file: audioFile,
      model: MODEL,
      language: "it",
      response_format: "text",
    });

    const text = typeof transcription === "string"
      ? transcription
      : (transcription as { text?: string }).text ?? "";

    // Best-effort blob cleanup (so we don't accumulate uploaded files).
    if (blobUrlToCleanup) {
      try {
        await del(blobUrlToCleanup);
      } catch (e) {
        console.warn("Blob cleanup failed (non-fatal):", e);
      }
    }

    return NextResponse.json({ text });
  } catch (err: unknown) {
    console.error("Transcribe API error:", err);
    const message = err instanceof Error ? err.message : "Unknown error";
    return NextResponse.json({ error: message }, { status: 500 });
  }
}
