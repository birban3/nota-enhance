"use client";

import { useState, useRef, useCallback } from "react";

// Groq's Whisper API rejects files >25 MB with a 413. Chunk anything that
// breaches this with a small safety margin (the WAV header + serialisation
// overhead also count against the cap).
const WHISPER_MAX_BYTES = 24 * 1024 * 1024;
// Whisper internally resamples to 16 kHz, so we lose nothing by decoding /
// re-encoding at that rate — and at 16 kHz mono 16-bit each chunk holds
// ~12.5 minutes of audio, which keeps the chunk count low for hour-long
// recordings.
const TARGET_SAMPLE_RATE = 16000;

/** Encode a mono Float32 sample stream as a 16-bit PCM WAV ArrayBuffer. */
function encodeWavMono16(samples: Float32Array, sampleRate: number): ArrayBuffer {
  const numFrames = samples.length;
  const dataSize = numFrames * 2;
  const out = new ArrayBuffer(44 + dataSize);
  const view = new DataView(out);
  // RIFF header
  view.setUint32(0, 0x52494646, false);   // "RIFF"
  view.setUint32(4, 36 + dataSize, true); // file size − 8
  view.setUint32(8, 0x57415645, false);   // "WAVE"
  // fmt sub-chunk
  view.setUint32(12, 0x666d7420, false);  // "fmt "
  view.setUint32(16, 16, true);           // PCM sub-chunk size
  view.setUint16(20, 1, true);            // PCM format
  view.setUint16(22, 1, true);            // mono
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * 2, true); // byte rate (mono 16-bit)
  view.setUint16(32, 2, true);            // block align
  view.setUint16(34, 16, true);           // bits per sample
  // data sub-chunk
  view.setUint32(36, 0x64617461, false);  // "data"
  view.setUint32(40, dataSize, true);
  let offset = 44;
  for (let i = 0; i < numFrames; i++) {
    let s = samples[i];
    if (s > 1) s = 1;
    else if (s < -1) s = -1;
    view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7fff, true);
    offset += 2;
  }
  return out;
}

function mixToMono(buffer: AudioBuffer): Float32Array {
  const channels = buffer.numberOfChannels;
  const length = buffer.length;
  const mono = new Float32Array(length);
  for (let c = 0; c < channels; c++) {
    const data = buffer.getChannelData(c);
    for (let i = 0; i < length; i++) mono[i] += data[i];
  }
  if (channels > 1) {
    for (let i = 0; i < length; i++) mono[i] /= channels;
  }
  return mono;
}

/** Linear-interp resampler. Speech is forgiving — no need for FIR filtering. */
function resampleLinear(input: Float32Array, srcRate: number, dstRate: number): Float32Array {
  if (srcRate === dstRate) return input;
  const ratio = dstRate / srcRate;
  const newLength = Math.floor(input.length * ratio);
  const out = new Float32Array(newLength);
  const lastIdx = input.length - 1;
  for (let i = 0; i < newLength; i++) {
    const srcPos = i / ratio;
    const lo = Math.floor(srcPos);
    const hi = lo + 1 <= lastIdx ? lo + 1 : lastIdx;
    const frac = srcPos - lo;
    out[i] = input[lo] * (1 - frac) + input[hi] * frac;
  }
  return out;
}

/**
 * If `file` is small enough for Whisper's 25 MB cap, return [file] unchanged.
 * Otherwise decode it via Web Audio, downsample to 16 kHz mono, and split into
 * sequential WAV chunks each ≤ WHISPER_MAX_BYTES. The transcripts can be
 * concatenated in order — Whisper handles silence/sentence boundaries
 * tolerably, so we don't bother with overlap or VAD-based splitting.
 *
 * Throws if the browser can't decode the source format. The caller is expected
 * to fall back to a single-shot upload in that case (which will surface the
 * real error from the server).
 */
async function splitAudioForTranscription(file: File): Promise<File[]> {
  if (file.size <= WHISPER_MAX_BYTES) return [file];

  const arrayBuffer = await file.arrayBuffer();

  // Decoding directly at TARGET_SAMPLE_RATE (when the browser supports it)
  // saves ~3× memory vs decoding at 48 kHz and resampling after — important
  // for hour-long recordings on lower-end devices. Some Safari versions
  // throw on the constructor option; fall back to default rate + manual
  // resample in that case.
  let audioContext: AudioContext;
  try {
    audioContext = new AudioContext({ sampleRate: TARGET_SAMPLE_RATE });
  } catch {
    audioContext = new AudioContext();
  }

  let decoded: AudioBuffer;
  try {
    decoded = await audioContext.decodeAudioData(arrayBuffer);
  } finally {
    try { audioContext.close(); } catch {}
  }

  const mono = mixToMono(decoded);
  const samples = decoded.sampleRate === TARGET_SAMPLE_RATE
    ? mono
    : resampleLinear(mono, decoded.sampleRate, TARGET_SAMPLE_RATE);

  // 44-byte WAV header + 2 bytes per sample (mono 16-bit). Solve:
  //   44 + samples * 2 ≤ WHISPER_MAX_BYTES.
  const maxSamplesPerChunk = Math.floor((WHISPER_MAX_BYTES - 44) / 2);
  const total = samples.length;
  const baseName = file.name.replace(/\.[^.]+$/, "") || "audio";

  if (total <= maxSamplesPerChunk) {
    // Source was big in compressed form but fits comfortably after the
    // 16 kHz downsample. One chunk, but still rewrap as WAV.
    const wav = encodeWavMono16(samples, TARGET_SAMPLE_RATE);
    return [new File([wav], `${baseName}.wav`, { type: "audio/wav" })];
  }

  const chunks: File[] = [];
  let part = 1;
  for (let start = 0; start < total; start += maxSamplesPerChunk) {
    const end = Math.min(total, start + maxSamplesPerChunk);
    const slice = samples.subarray(start, end);
    const wav = encodeWavMono16(slice, TARGET_SAMPLE_RATE);
    chunks.push(
      new File([wav], `${baseName}-part${part}.wav`, { type: "audio/wav" })
    );
    part++;
  }
  return chunks;
}

/**
 * Uploads `file` and returns the transcription text.
 *
 * Strategy:
 *   0. If `file` exceeds Whisper's 25 MB cap, decode + downsample on the
 *      client and split into sequential ≤24 MB WAV chunks. Each chunk goes
 *      through the path below in order, and the transcripts are joined.
 *      The split is best-effort: if the browser can't decode the format,
 *      we fall through to a single-shot upload and let the server's error
 *      surface to the user.
 *   1. Try Vercel Blob direct upload — bypasses Vercel's 4.5 MB body cap.
 *      Only works when `BLOB_READ_WRITE_TOKEN` is configured AND the Blob
 *      store has the deploy origin in its CORS allowlist. Either condition
 *      can fail in real deploys (token misbinding, missing origin entry…),
 *      and the failure mode of the second one is a CORS error that surfaces
 *      as an opaque "Failed to fetch" — not a clean status code.
 *   2. Fall back to FormData POST to `/api/transcribe`. The serverless body
 *      cap (4.5 MB) means files larger than that will 413 here, but that
 *      gives the user a clear error instead of a cryptic CORS one.
 *
 * We fall back on ANY blob-path failure, not just the historical "503 not
 * configured" case, because real-world failures (CORS, expired token,
 * region issue) all leave the user staring at a console error otherwise.
 */
async function uploadAndTranscribe(
  file: File,
  onProgress?: (current: number, total: number) => void
): Promise<string> {
  let chunks: File[];
  try {
    chunks = await splitAudioForTranscription(file);
  } catch (decodeErr) {
    // Splitting is best-effort. If the browser refuses to decode the file
    // (unsupported codec, corrupted container, …), pass the raw file through
    // and let the server reject it with a clearer message. Logging here
    // keeps the original error visible during dev.
    console.warn("Audio split failed, falling back to single upload:", decodeErr);
    chunks = [file];
  }

  // Defensive: a successful decode that yielded zero samples (silent or
  // empty container) would otherwise leave the user with no transcript and
  // no error. Send the original file to Whisper instead — let it decide.
  if (chunks.length === 0) chunks = [file];

  if (chunks.length === 1) {
    onProgress?.(1, 1);
    return transcribeOne(chunks[0]);
  }

  const parts: string[] = [];
  for (let i = 0; i < chunks.length; i++) {
    onProgress?.(i + 1, chunks.length);
    const text = await transcribeOne(chunks[i]);
    if (text) parts.push(text);
  }
  // Single space between chunks: Whisper already trims whitespace per chunk,
  // and we don't want a hard newline that could be misread as a paragraph
  // break by the editor.
  return parts.join(" ").trim();
}

/** Single-chunk upload + transcribe — formerly the body of uploadAndTranscribe. */
async function transcribeOne(file: File): Promise<string> {
  // ── Path A: Blob client upload, then handoff URL to /api/transcribe ──
  let blobError: unknown = null;
  let uploadSucceeded = false;
  try {
    const { upload } = await import("@vercel/blob/client");
    // The store on Vercel is configured with `private` access. The client
    // upload's `access` field MUST match the store's mode, otherwise the
    // platform rejects with "Cannot use public access on a private store".
    // Server-side reads (in /api/transcribe) authenticate via the
    // BLOB_READ_WRITE_TOKEN — the URL itself isn't directly fetchable.
    const newBlob = await upload(file.name, file, {
      access: "private",
      handleUploadUrl: "/api/blob/upload-token",
      contentType: file.type || "audio/webm",
    });
    uploadSucceeded = true;
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: newBlob.url,
        filename: file.name,
        contentType: file.type || "audio/webm",
      }),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      throw new Error(
        (data as { error?: string }).error ||
        `Errore trascrizione (HTTP ${res.status})`
      );
    }
    return (((data as { text?: string }).text) || "").trim();
  } catch (err) {
    blobError = err;
    if (uploadSucceeded) {
      // The Blob upload itself worked; the failure is in transcribe (e.g.
      // Whisper rejecting the codec). The FormData fallback hits the same
      // Whisper endpoint with the same content, so it can't help — and
      // for >4.5 MB it would just 413 with a misleading message. Surface
      // the real error directly.
      throw err;
    }
    console.warn("Blob upload failed, falling back to FormData:", err);
  }

  // ── Path B: classic FormData direct upload (local dev / Blob misconfigured) ──
  // Hits the 4.5 MB Vercel serverless body cap; large files will 413 here
  // and we surface a clearer message including the original Blob error so
  // the user knows what to fix.
  try {
    const formData = new FormData();
    formData.append("audio", file);
    const res = await fetch("/api/transcribe", { method: "POST", body: formData });
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      if (res.status === 413) {
        // Path A (Blob direct upload) is the one designed for files this
        // big — if we ended up here it failed for some other reason.
        // Surface that the Blob path is what actually broke, and point
        // the user at the console where the original error was logged.
        throw new Error(
          "File troppo grande per l'upload diretto via API (>4.5 MB) e l'upload " +
          "su Vercel Blob non è andato a buon fine. Controlla la console del " +
          "browser per il dettaglio dell'errore Blob."
        );
      }
      throw new Error((data as { error?: string }).error || `Errore trascrizione (HTTP ${res.status})`);
    }
    return (((data as { text?: string }).text) || "").trim();
  } catch (formErr) {
    // Both paths failed. Surface the most actionable error. If Path B's
    // error is the 413 we crafted above, prefer it; otherwise prefer the
    // original Blob error which usually tells us why the primary path
    // (the one designed for this file size) failed.
    const formMsg = formErr instanceof Error ? formErr.message : String(formErr);
    if (/troppo grande|413|cors|allowed origin/i.test(formMsg)) {
      throw formErr;
    }
    throw blobError instanceof Error ? blobError : (formErr as Error);
  }
}

interface UseAudioRecorderReturn {
  isRecording: boolean;
  recordTime: number;
  audioURL: string | null;
  transcript: string;
  setTranscript: (t: string | ((prev: string) => string)) => void;
  startRecording: () => Promise<void>;
  stopRecording: () => void;
  error: string | null;
  clearError: () => void;
  importAudio: (file: File, label?: string) => Promise<void>;
  importedFileName: string | null;
  isTranscribingFile: boolean;
  /** True while a just-finished recording is being uploaded to /api/transcribe. */
  isTranscribingRecording: boolean;
  /** Chunk progress for files that had to be split (>25 MB). null when the
   *  current transcription is single-shot or no transcription is running. */
  transcribeChunkProgress: { current: number; total: number } | null;
  getAnalyser: () => AnalyserNode | null;
}

/**
 * Recording flow (rev: record → upload → transcribe).
 *
 * Old behaviour: live Web Speech API streaming a partial transcript while
 *   recording. Cheap but inaccurate, browser-locked, and the user could not
 *   distinguish "finished recording" from "finished transcribing".
 *
 * New behaviour: pure MediaRecorder for the duration of the session — no
 *   live transcription. On stop we POST the captured Blob to /api/transcribe
 *   (Groq Whisper) and append the final, accurate transcript. The
 *   `isTranscribingRecording` flag lets the UI show a spinner during upload.
 */
export function useAudioRecorder(): UseAudioRecorderReturn {
  const [isRecording, setIsRecording] = useState(false);
  const [recordTime, setRecordTime] = useState(0);
  const [audioURL, setAudioURL] = useState<string | null>(null);
  const [transcript, setTranscript] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [importedFileName, setImportedFileName] = useState<string | null>(null);
  const [isTranscribingFile, setIsTranscribingFile] = useState(false);
  const [isTranscribingRecording, setIsTranscribingRecording] = useState(false);
  // Multi-chunk progress for >25 MB inputs. Only exposed (non-null) when the
  // file actually had to be split, so single-shot uploads don't flash a 1/1
  // pill in the header.
  const [transcribeChunkProgress, setTranscribeChunkProgress] = useState<{
    current: number;
    total: number;
  } | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const startTimeRef = useRef<number>(0);
  const analyserRef = useRef<AnalyserNode | null>(null);

  const getAnalyser = useCallback(() => analyserRef.current, []);

  const clearError = useCallback(() => setError(null), []);

  const transcribeBlob = useCallback(async (blob: Blob, filename: string) => {
    setIsTranscribingRecording(true);
    try {
      const file = new File([blob], filename, { type: blob.type || "audio/webm" });
      const text = await uploadAndTranscribe(file, (cur, total) => {
        setTranscribeChunkProgress(total > 1 ? { current: cur, total } : null);
      });
      if (text) {
        setTranscript((prev) => (prev ? prev.trim() + "\n\n" + text : text));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Errore trascrizione";
      setError("Trascrizione registrazione: " + message);
    } finally {
      setIsTranscribingRecording(false);
      setTranscribeChunkProgress(null);
    }
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
    // Clear any leftover audioURL from a previous file upload — the player
    // shouldn't render during/after a recording (recording playback is
    // intentionally not exposed; see mediaRecorder.onstop). Revoke the prior
    // blob: URL while we're at it so it doesn't leak.
    setAudioURL((prev) => {
      if (prev && prev.startsWith("blob:")) {
        try { URL.revokeObjectURL(prev); } catch {}
      }
      return null;
    });
    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          autoGainControl: true,
          noiseSuppression: false,
          echoCancellation: false,
          channelCount: 1,
          sampleRate: 48000,
        },
      });

      const audioContext = new AudioContext();
      const source = audioContext.createMediaStreamSource(stream);
      const gainNode = audioContext.createGain();
      gainNode.gain.value = 2.5;
      const destination = audioContext.createMediaStreamDestination();

      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 256;
      analyser.smoothingTimeConstant = 0.7;
      analyserRef.current = analyser;

      source.connect(gainNode);
      gainNode.connect(destination);
      gainNode.connect(analyser);

      const mediaRecorder = new MediaRecorder(destination.stream);
      chunksRef.current = [];

      mediaRecorder.ondataavailable = (e) => {
        if (e.data.size > 0) chunksRef.current.push(e.data);
      };

      mediaRecorder.onstop = () => {
        const blob = new Blob(chunksRef.current, { type: "audio/webm" });
        // Recording playback is intentionally NOT exposed via `audioURL`:
        // the in-app <audio> element doesn't reliably play raw MediaRecorder
        // webm blobs (Safari especially), which surfaced as a stale "Errore"
        // chip in the player chrome after stop. The player exists for
        // user-uploaded audio only — we still want a clean way to *listen*
        // to a recording, and the transcript itself replaces playback as
        // the canonical artefact of the recording flow.
        stream.getTracks().forEach((t) => t.stop());
        analyserRef.current = null;
        audioContext.close();
        // Send to Whisper for accurate transcription.
        const stamp = new Date()
          .toISOString()
          .replace(/[-:T]/g, "")
          .slice(0, 14);
        if (blob.size > 0) {
          void transcribeBlob(blob, `registrazione-${stamp}.webm`);
        }
      };

      mediaRecorder.start(1000);
      mediaRecorderRef.current = mediaRecorder;
      setIsRecording(true);
      startTimeRef.current = Date.now();
      setRecordTime(0);
      if (timerRef.current) clearInterval(timerRef.current);
      timerRef.current = setInterval(() => {
        const elapsed = Math.floor((Date.now() - startTimeRef.current) / 1000);
        setRecordTime((prev) => (prev !== elapsed ? elapsed : prev));
      }, 250);
    } catch {
      setError("Accesso al microfono negato.");
    }
  }, [transcribeBlob]);

  const stopRecording = useCallback(() => {
    if (mediaRecorderRef.current?.state === "recording") {
      mediaRecorderRef.current.stop();
    }
    if (timerRef.current) {
      clearInterval(timerRef.current);
      timerRef.current = null;
    }
    setIsRecording(false);
  }, []);

  const importAudio = useCallback(async (file: File, label?: string) => {
    setImportedFileName(file.name);
    // Revoke the previous object URL before assigning a new one — across
    // a multi-file import this avoids accumulating MB-scale blob: URLs in
    // memory until tab close. setAudioURL with the functional updater so
    // we get the prior value in a render-safe way.
    setAudioURL((prev) => {
      if (prev && prev.startsWith("blob:")) {
        try { URL.revokeObjectURL(prev); } catch {}
      }
      return URL.createObjectURL(file);
    });
    setError(null);
    setIsTranscribingFile(true);

    try {
      const text = await uploadAndTranscribe(file, (cur, total) => {
        setTranscribeChunkProgress(total > 1 ? { current: cur, total } : null);
      });
      if (text) {
        // When the caller passes a label (multi-file import flow), prepend
        // it as a divider so the transcript stays navigable. Single-file
        // imports leave it off — the existing UX of one transcript per
        // import doesn't need a header.
        const block = label ? `${label}\n${text}` : text;
        setTranscript((prev) => (prev ? prev.trim() + "\n\n" + block : block));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Errore trascrizione";
      setError("Trascrizione file: " + message);
    } finally {
      setIsTranscribingFile(false);
      setTranscribeChunkProgress(null);
    }
  }, []);

  return {
    isRecording,
    recordTime,
    audioURL,
    transcript,
    setTranscript,
    startRecording,
    stopRecording,
    error,
    clearError,
    importAudio,
    importedFileName,
    isTranscribingFile,
    isTranscribingRecording,
    transcribeChunkProgress,
    getAnalyser,
  };
}
