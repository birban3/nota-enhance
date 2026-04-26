// Web Speech API types — not in TS lib.dom by default.
// Minimal shim covering only what useAudioRecorder uses.

interface SpeechRecognitionAlternative {
  readonly transcript: string;
  readonly confidence: number;
}

interface SpeechRecognitionResult {
  readonly isFinal: boolean;
  readonly length: number;
  [index: number]: SpeechRecognitionAlternative;
}

interface SpeechRecognitionResultList {
  readonly length: number;
  [index: number]: SpeechRecognitionResult;
}

interface SpeechRecognitionEvent extends Event {
  readonly resultIndex: number;
  readonly results: SpeechRecognitionResultList;
}

interface SpeechRecognitionErrorEvent extends Event {
  readonly error: string;
  readonly message: string;
}

interface SpeechRecognition extends EventTarget {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((this: SpeechRecognition, ev: SpeechRecognitionEvent) => void) | null;
  onerror: ((this: SpeechRecognition, ev: SpeechRecognitionErrorEvent) => void) | null;
  onend: ((this: SpeechRecognition, ev: Event) => void) | null;
  start(): void;
  stop(): void;
  abort(): void;
}

declare const SpeechRecognition: {
  prototype: SpeechRecognition;
  new (): SpeechRecognition;
};

interface Window {
  SpeechRecognition?: typeof SpeechRecognition;
  webkitSpeechRecognition?: typeof SpeechRecognition;
}

// html2pdf.js — no official typings. Just enough surface for our use.
declare module "html2pdf.js" {
  interface Html2PdfWorker {
    from(element: HTMLElement | string): Html2PdfWorker;
    set(options: Record<string, unknown>): Html2PdfWorker;
    save(filename?: string): Promise<void>;
    output(type: string, options?: unknown): Promise<unknown>;
    outputPdf(type?: string): Promise<unknown>;
    then<T>(onFulfilled?: (value: unknown) => T | PromiseLike<T>): Promise<T>;
  }
  function html2pdf(): Html2PdfWorker;
  function html2pdf(element: HTMLElement, options?: Record<string, unknown>): Promise<void>;
  export default html2pdf;
}
