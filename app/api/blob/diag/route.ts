import { NextResponse } from "next/server";
import { put, del } from "@vercel/blob";

// Diagnostic — proves whether BLOB_READ_WRITE_TOKEN is valid by doing a
// tiny SERVER-SIDE round-trip (write then delete a 12-byte file).
// If this works, the issue is the *client* upload flow / origin trust.
// If this fails, the token itself is bad / store unreachable.
//
// Auth-protected by middleware. Only the logged-in user can hit it.

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export async function GET() {
  if (!process.env.BLOB_READ_WRITE_TOKEN) {
    return NextResponse.json(
      { ok: false, stage: "env", error: "BLOB_READ_WRITE_TOKEN non impostata sul deploy." },
      { status: 503 }
    );
  }

  const tokenPrefix = process.env.BLOB_READ_WRITE_TOKEN.slice(0, 18);
  const tokenLen = process.env.BLOB_READ_WRITE_TOKEN.length;

  try {
    // Tiny payload — won't count against quotas.
    const blob = await put(`diag-${Date.now()}.txt`, "ping ok", {
      access: "public",
      addRandomSuffix: true,
      contentType: "text/plain",
    });

    // Immediate cleanup so we don't accumulate diagnostic files.
    try { await del(blob.url); } catch {}

    return NextResponse.json({
      ok: true,
      stage: "put-then-del",
      tokenPrefix,
      tokenLen,
      blobUrl: blob.url,
      message: "Server-side put+del riusciti. BLOB_READ_WRITE_TOKEN è valida e lo store è raggiungibile.",
    });
  } catch (err) {
    return NextResponse.json(
      {
        ok: false,
        stage: "put",
        tokenPrefix,
        tokenLen,
        error: err instanceof Error ? err.message : String(err),
      },
      { status: 500 }
    );
  }
}
