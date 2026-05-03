"use client";

import { useState, useRef, useCallback } from "react";

/**
 * Uploads `file` and returns the transcription text.
 *
 * Strategy:
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
async function uploadAndTranscribe(file: File): Promise<string> {
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
      const text = await uploadAndTranscribe(file);
      if (text) {
        setTranscript((prev) => (prev ? prev.trim() + "\n\n" + text : text));
      }
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Errore trascrizione";
      setError("Trascrizione registrazione: " + message);
    } finally {
      setIsTranscribingRecording(false);
    }
  }, []);

  const startRecording = useCallback(async () => {
    setError(null);
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
        setAudioURL(URL.createObjectURL(blob));
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
    setAudioURL(URL.createObjectURL(file));
    setError(null);
    setIsTranscribingFile(true);

    try {
      const text = await uploadAndTranscribe(file);
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
    getAnalyser,
  };
}
