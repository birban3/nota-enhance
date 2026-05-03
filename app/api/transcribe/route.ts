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
  // relay where attackers point us at arbitrary URLs. Both `*.public.` and
  // `*.private.` subdomains are valid — the SDK constructs the URL based on
  // the store's access mode, and our store is configured private.
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new Error("URL Blob non valido.");
  }
  if (!parsed.hostname.endsWith(".blob.vercel-storage.com")) {
    throw new Error("URL non riconosciuto come Vercel Blob.");
  }
  // Match the actual store mode: subdomain is either `.public.` or
  // `.private.`. Anything else is a forged URL pointing nowhere we control.
  const isPrivate = parsed.hostname.includes(".private.");
  const isPublic = parsed.hostname.includes(".public.");
  if (!isPrivate && !isPublic) {
    throw new Error("URL Blob malformato (manca .public./.private.).");
  }

  // Public blobs are anonymously fetchable; private blobs need the
  // BLOB_READ_WRITE_TOKEN as Bearer auth. We do a plain fetch in both
  // cases (rather than the SDK's `get()`) because:
  //   - it's a single network primitive with predictable error shape
  //   - `get()` returned a typed object that wrapped the response body
  //     in ways that made debugging the recent .aac 500 harder than
  //     necessary
  //   - on Edge/Node both have global fetch — no extra deps
  const fetchHeaders: Record<string, string> = {};
  if (isPrivate) {
    const token = process.env.BLOB_READ_WRITE_TOKEN;
    if (!token) {
      throw new Error("BLOB_READ_WRITE_TOKEN mancante: impossibile leggere blob privati.");
    }
    fetchHeaders.authorization = `Bearer ${token}`;
  }
  const fetched = await fetch(url, { headers: fetchHeaders });
  if (!fetched.ok) {
    throw new Error(
      `Fetch del Blob fallito: ${fetched.status} ${fetched.statusText} (${isPrivate ? "private" : "public"})`
    );
  }
  const buf = await fetched.arrayBuffer();
  const respContentType = fetched.headers.get("content-type");
  const file = new File([buf], filename || "audio.webm", {
    type: contentType || respContentType || "audio/webm",
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
    // OpenAI SDK errors carry a `status` and frequently a structured
    // `error.message` that's much more actionable than the SDK's
    // top-level `message`. Pass both back to the client so the toast
    // shows e.g. "Invalid file format. Please upload mp3/m4a/wav/…"
    // instead of a generic 500.
    const e = err as {
      status?: number;
      message?: string;
      error?: { message?: string };
      response?: { status?: number };
    };
    const status =
      typeof e.status === "number" ? e.status :
      typeof e.response?.status === "number" ? e.response.status :
      500;
    const innerMsg = e.error?.message || e.message;
    let message = innerMsg || "Unknown transcribe error";
    // Whisper's "invalid file format" replies are usually a 400 — annotate
    // so the user knows it's not our server falling over.
    if (status === 400 && /format|invalid|decode|codec/i.test(message)) {
      message = `Whisper non può decodificare questo file: ${message}. Formati supportati: mp3, m4a, mp4, mpeg, mpga, oga, ogg, wav, webm, flac.`;
    }
    return NextResponse.json({ error: message }, { status: status >= 400 && status < 600 ? status : 500 });
  }
}
