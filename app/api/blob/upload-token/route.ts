import { NextRequest, NextResponse } from "next/server";
import { handleUpload, type HandleUploadBody } from "@vercel/blob/client";

// Vercel Blob client-upload handler.
//
// Why we need this:
//   Vercel serverless functions have a hard 4.5 MB request body limit. Our
//   audio files (Groq Whisper accepts up to 25 MB) routinely exceed that.
//   The fix is direct browser-to-Blob upload: the client requests a signed
//   token from this endpoint, then PUTs the file directly to the Blob CDN
//   (no body limit). The server only ever sees small JSON.
//
// If `BLOB_READ_WRITE_TOKEN` is not configured (e.g. local dev without a
// Blob store linked), we return 503 so the client can fall back to a
// classic FormData upload — which works locally because the Next.js dev
// server doesn't enforce the 4.5 MB cap.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function POST(req: NextRequest) {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { error: "Vercel Blob non configurato. Fallback a upload diretto." },
      { status: 503 }
    );
  }

  let body: HandleUploadBody;
  try {
    body = (await req.json()) as HandleUploadBody;
  } catch {
    return NextResponse.json({ error: "Invalid JSON body." }, { status: 400 });
  }

  try {
    const json = await handleUpload({
      body,
      request: req,
      onBeforeGenerateToken: async () => ({
        allowedContentTypes: [
          "audio/*",
          "application/octet-stream", // some browsers send this for .webm/.m4a
        ],
        addRandomSuffix: true,
        maximumSizeInBytes: 100 * 1024 * 1024, // 100 MB cap (Groq itself caps at 25)
        // Auto-delete the blob 1 hour from upload — we only need it during
        // the transcription request, then it can go.
        validUntil: Date.now() + 60 * 60 * 1000,
      }),
      onUploadCompleted: async () => {
        // Nothing to do — the client posts the URL to /api/transcribe next.
      },
    });
    return NextResponse.json(json);
  } catch (err) {
    console.error("Blob upload-token error:", err);
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Upload token error." },
      { status: 400 }
    );
  }
}
