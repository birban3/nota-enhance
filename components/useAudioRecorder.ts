"use client";

import { useState, useRef, useCallback } from "react";

/**
 * Uploads `file` and returns the transcription text.
 *
 * Strategy:
 *   1. Try Vercel Blob direct upload — bypasses Vercel's 4.5 MB body cap.
 *      Only works when `BLOB_READ_WRITE_TOKEN` is configured server-side
 *      (production). The `/api/blob/upload-token` endpoint returns 503 if
 *      not — that's our signal to fall back.
 *   2. Fall back to direct FormData POST to `/api/transcribe`. This works
 *      in local dev (no body cap) and for tiny files in prod.
 */
async function uploadAndTranscribe(file: File): Promise<string> {
  // ── Path A: Blob client upload, then handoff URL to /api/transcribe ──
  try {
    const { upload } = await import("@vercel/blob/client");
    const newBlob = await upload(file.name, file, {
      access: "public",
      handleUploadUrl: "/api/blob/upload-token",
      contentType: file.type || "audio/webm",
    });
    const res = await fetch("/api/transcribe", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        url: newBlob.url,
        filename: file.name,
        contentType: file.type || "audio/webm",
      }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error || "Errore trascrizione");
    return ((data.text as string) || "").trim();
  } catch (blobErr) {
    // If the Blob path failed because the server returned 503 (Blob not
    // configured) or any network-level fall-through, try direct upload.
    const errMsg = blobErr instanceof Error ? blobErr.message : String(blobErr);
    const looksLikeBlobNotConfigured = /503|non configurato|fallback/i.test(errMsg);
    if (!looksLikeBlobNotConfigured) {
      // Real Blob error (auth, validation, etc.) — surface it instead of silently
      // hammering the small-body endpoint with a multi-MB upload that will 413.
      throw blobErr;
    }
  }

  // ── Path B: classic FormData direct upload (local dev / no Blob) ──
  const formData = new FormData();
  formData.append("audio", file);
  const res = await fetch("/api/transcribe", { method: "POST", body: formData });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error || "Errore trascrizione");
  return ((data.text as string) || "").trim();
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
  importAudio: (file: File) => Promise<void>;
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

  const importAudio = useCallback(async (file: File) => {
    setImportedFileName(file.name);
    setAudioURL(URL.createObjectURL(file));
    setError(null);
    setIsTranscribingFile(true);

    try {
      const text = await uploadAndTranscribe(file);
      if (text) {
        const label = `[📁 ${file.name}]`;
        setTranscript((prev) => (prev ? prev.trim() + "\n\n" + label + "\n" + text : label + "\n" + text));
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
