"use client";

import { useState, useRef, useCallback, useEffect, useMemo } from "react";
import dynamic from "next/dynamic";
import { AnimatePresence, motion } from "framer-motion";
import { useAudioRecorder } from "@/components/useAudioRecorder";
import { NotesSidebar, type ArchivedNote, type AskMsg } from "@/components/NotesSidebar";
import { CommandPalette } from "@/components/CommandPalette";
import { AudioWaveform } from "@/components/AudioWaveform";
import { getVal, setVal } from "@/lib/storage";
import { SettingsModal } from "@/components/SettingsModal";
import {
  Square, Download, Sparkles, X, Loader2, ChevronUp, PanelLeft,
  FileDown, MessageCircle, Send, Search,
} from "lucide-react";
import type { TiptapHandle } from "@/components/TiptapEditor";
import {
  DEFAULT_SHORTCUTS,
  formatShortcut,
  loadShortcuts,
  matchesShortcut,
  saveShortcuts,
  type Shortcut,
  type ShortcutId,
} from "@/lib/shortcuts";

const TiptapEditor = dynamic(() => import("@/components/TiptapEditor"), {
  ssr: false,
  loading: () => <div className="p-6 text-text-muted text-sm">Caricamento editor...</div>,
});

const STORAGE_KEY = "nota-enhance-archive";
const ACTIVE_ID_KEY = "nota-enhance-active-id";
const TOMBSTONES_KEY = "nota-enhance-tombstones";
const DEFAULT_SPLIT = 0.5;
// Debounce window between local changes and the next remote push. Long
// enough that fast typing batches into one PUT, short enough that switching
// devices feels live.
const REMOTE_SYNC_DEBOUNCE_MS = 2500;

/* ── Markdown → HTML (tolerant of inline tags emitted by Tiptap serializer) ──
   The Tiptap → markdown serializer emits raw <u>...</u> for underline and ==..==
   for highlight (Tiptap doesn't have a canonical markdown form for these). The
   reverse path therefore has to:
     1. preserve those inline tags through HTML escaping
     2. re-process bold (**), italic (*), highlight (==), and the inline-tag
        placeholders into proper HTML
   Order matters: bold first (so its `**` aren't eaten by the italic pass),
   then italic, then highlight, then escape-restore.
*/
function mdToHtml(md: string): string {
  const lines = md.split("\n");
  let html = "";
  let inUl = false;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

  // Image with optional |size suffix in alt: "alt|small" or "alt|large".
  const IMG_RE = /!\[([^\]]*?)\]\(([^)]+)\)/g;
  // File chip
  const FILE_RE = /\[📎 ([^\]]*)\]\(([^)]+)\)/g;

  const inline = (s: string) => {
    // 1. Replace <u>..</u> and <br> with placeholders so HTML escape
    //    doesn't kill them. <br> comes from Tiptap hardBreak round-trip
    //    (Shift+Enter inside a paragraph) — without this it'd come out
    //    as literal "&lt;br&gt;" text instead of a line break.
    const uOpen = "\x00U_OPEN\x00";
    const uClose = "\x00U_CLOSE\x00";
    const brTag = "\x00BR\x00";
    let t = s
      .replace(/<u>/g, uOpen)
      .replace(/<\/u>/g, uClose)
      .replace(/<br\s*\/?>/gi, brTag);

    // 2. Pull out images & file chips first (they contain `(` `)` etc.)
    const placeholders: string[] = [];
    t = t.replace(IMG_RE, (_m, alt: string, src: string) => {
      const parts = alt.split("|");
      const realAlt = parts[0] || "";
      // Default small unless the markdown explicitly opted into "large".
      const size = parts[1] === "large" ? "large" : "small";
      placeholders.push(`<img class="tiptap-img" data-size="${size}" src="${src}" alt="${esc(realAlt)}" />`);
      return `\x00P${placeholders.length - 1}\x00`;
    });
    t = t.replace(FILE_RE, (_m, name: string, src: string) => {
      placeholders.push(`<div data-type="file-attachment" name="${esc(name)}" src="${src}"></div>`);
      return `\x00P${placeholders.length - 1}\x00`;
    });

    // 3. HTML-escape the rest.
    t = esc(t);

    // 4. Restore underline + hard-break placeholders.
    t = t.split(uOpen).join("<u>").split(uClose).join("</u>").split(brTag).join("<br>");

    // 5. Bold first (eats its own `**`), then italic, then highlight.
    t = t.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    t = t.replace(/(^|[^*])\*([^*\n]+?)\*(?!\*)/g, "$1<em>$2</em>");
    t = t.replace(/==(.+?)==/g, '<mark class="hl-hermes">$1</mark>');

    // 6. Drop placeholders back in.
    t = t.replace(/\x00P(\d+)\x00/g, (_m, i) => placeholders[Number(i)]);
    return t;
  };

  // Lines that are just an image or just a file-chip should NOT be wrapped in
  // a <p> — Tiptap treats <image> and <fileAttachment> as block nodes, and
  // wrapping them in a paragraph stacks paragraph-margin on top of the
  // node-margin (made the gap between two consecutive images grow on every
  // refresh). Detect "pure block" lines and emit them raw.
  const PURE_IMG_RE = /^!\[[^\]]*\]\([^)]+\)$/;
  const PURE_FILE_RE = /^\[📎 [^\]]*\]\([^)]+\)$/;

  for (const line of lines) {
    const t = line.trim();
    if (/^[-*] /.test(t)) {
      if (!inUl) { html += "<ul>"; inUl = true; }
      html += `<li><p>${inline(t.slice(2))}</p></li>`;
    } else {
      if (inUl) { html += "</ul>"; inUl = false; }
      if (t.startsWith("> ")) html += `<blockquote><p>${inline(t.slice(2))}</p></blockquote>`;
      else if (t.startsWith("### ")) html += `<h3>${inline(t.slice(4))}</h3>`;
      else if (t.startsWith("## ")) html += `<h2>${inline(t.slice(3))}</h2>`;
      else if (t.startsWith("# ")) html += `<h1>${inline(t.slice(2))}</h1>`;
      else if (PURE_IMG_RE.test(t) || PURE_FILE_RE.test(t)) html += inline(t);
      else if (t === "") html += `<p></p>`;
      else html += `<p>${inline(t)}</p>`;
    }
  }
  if (inUl) html += "</ul>";
  return html;
}

function formatTime(s: number): string {
  return `${Math.floor(s / 60).toString().padStart(2, "0")}:${(s % 60).toString().padStart(2, "0")}`;
}

function uid(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function newEmptyNote(): ArchivedNote {
  const now = Date.now();
  return {
    id: uid(),
    title: "",
    notes: "",
    transcript: "",
    enhancedHtml: "",
    createdAt: now,
    updatedAt: now,
    manualTitle: false,
    pinned: false,
    splitRatio: DEFAULT_SPLIT,
  };
}

// AskMsg is exported from NotesSidebar so the persistent shape stays in one place.

export default function Home() {
  const notesRef = useRef<TiptapHandle>(null);
  const enhancedRef = useRef<TiptapHandle>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const sidebarHoverRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const handleSidebarHoverEnter = useCallback(() => {
    if (sidebarHoverRef.current) { clearTimeout(sidebarHoverRef.current); sidebarHoverRef.current = null; }
    setSidebarOpen(true);
  }, []);
  const handleSidebarHoverLeave = useCallback(() => {
    sidebarHoverRef.current = setTimeout(() => {
      setSidebarOpen(false);
    }, 200);
  }, []);

  const [enhancedHtml, setEnhancedHtml] = useState<string>("");
  const [isEnhancing, setIsEnhancing] = useState(false);
  // Click-driven transcript drawer.
  const [showTranscript, setShowTranscript] = useState(false);
  const [appError, setAppError] = useState<string | null>(null);
  const [notesVersion, setNotesVersion] = useState(0);
  const [enhancedVersion, setEnhancedVersion] = useState(0);
  const [initialNotesHtml, setInitialNotesHtml] = useState<string>("");

  const [title, setTitle] = useState<string>("");
  const [titleManual, setTitleManual] = useState<boolean>(false);

  const [promptModalOpen, setPromptModalOpen] = useState(false);
  const [enhanceInstructions, setEnhanceInstructions] = useState("");
  const [includeImages, setIncludeImages] = useState(true);
  const [includePdfs, setIncludePdfs] = useState(true);

  const [archive, setArchive] = useState<ArchivedNote[]>([]);
  const [activeId, setActiveId] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  // Tombstones travel alongside the archive so that a delete made on one
  // device propagates correctly to others. id → deletedAt epoch ms. The
  // server merges these with its own tombstones; old entries (>30d) are
  // garbage-collected server-side. Persisted in IDB for offline continuity.
  const [tombstones, setTombstones] = useState<Record<string, number>>({});

  // UI state
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  // Mobile-only: which pane is visible. Below the md breakpoint the two
  // editors stack into a tab switcher (single pane on screen at a time) since
  // the side-by-side split + draggable divider is unusable at < 768px wide.
  // Desktop ignores this state entirely (CSS shows both panes via md:flex).
  const [mobilePane, setMobilePane] = useState<"notes" | "enhanced">("notes");

  // Auth — middleware ensures we get here only when logged in. We still fetch
  // the username for the sidebar tooltip and provide a logout handler.
  const [username, setUsername] = useState<string | null>(null);
  useEffect(() => {
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => setUsername(d.username || null))
      .catch(() => {});
  }, []);
  const handleLogout = useCallback(async () => {
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {}
    window.location.href = "/login";
  }, []);

  // Ask AI
  const [askOpen, setAskOpen] = useState(false);
  const [askInput, setAskInput] = useState("");
  const [askMessages, setAskMessages] = useState<AskMsg[]>([]);
  const [askLoading, setAskLoading] = useState(false);

  // Customizable shortcuts (persisted)
  const [shortcuts, setShortcuts] = useState<Record<ShortcutId, Shortcut>>(DEFAULT_SHORTCUTS);
  useEffect(() => { setShortcuts(loadShortcuts()); }, []);
  const updateShortcuts = useCallback((next: Record<ShortcutId, Shortcut>) => {
    setShortcuts(next);
    saveShortcuts(next);
  }, []);

  // Per-note split between Notes and Enhanced. Defaults to 0.5; persisted on
  // the active note (so each note remembers its own ratio across reloads).
  const [splitRatio, setSplitRatio] = useState(DEFAULT_SPLIT);
  const splitContainerRef = useRef<HTMLDivElement>(null);
  const [isDraggingSplit, setIsDraggingSplit] = useState(false);

  const {
    isRecording, recordTime, audioURL, transcript, setTranscript,
    startRecording, stopRecording, error: recError, clearError,
    importAudio, importedFileName, isTranscribingFile, isTranscribingRecording, getAnalyser,
  } = useAudioRecorder();

  const displayError = appError || recError;

  // ── Hydrate ──
  useEffect(() => {
    async function loadData() {
      try {
        let storedIdb = await getVal<ArchivedNote[]>(STORAGE_KEY);
        if (!storedIdb) {
          const raw = localStorage.getItem(STORAGE_KEY);
          if (raw) {
            storedIdb = JSON.parse(raw);
            await setVal(STORAGE_KEY, storedIdb);
            localStorage.removeItem(STORAGE_KEY);
          }
        }
        const stored = storedIdb || [];

        let storedActiveId = await getVal<string>(ACTIVE_ID_KEY);
        if (!storedActiveId) {
          storedActiveId = localStorage.getItem(ACTIVE_ID_KEY) || "";
          if (storedActiveId) {
            await setVal(ACTIVE_ID_KEY, storedActiveId);
            localStorage.removeItem(ACTIVE_ID_KEY);
          }
        }

        const storedTombstones =
          (await getVal<Record<string, number>>(TOMBSTONES_KEY)) || {};
        setTombstones(storedTombstones);

        if (stored.length === 0) {
          const first = newEmptyNote();
          setArchive([first]);
          setActiveId(first.id);
          setSplitRatio(first.splitRatio ?? DEFAULT_SPLIT);
        } else {
          setArchive(stored);
          const valid = stored.find((n) => n.id === storedActiveId)?.id ?? stored[0].id;
          setActiveId(valid);
          const active = stored.find((n) => n.id === valid)!;
          setInitialNotesHtml(mdToHtml(active.notes));
          setEnhancedHtml(active.enhancedHtml || "");
          setTranscript(active.transcript || "");
          setTitle(active.title || "");
          setTitleManual(!!active.manualTitle);
          setSplitRatio(active.splitRatio ?? DEFAULT_SPLIT);
          setAskMessages(active.askMessages || []);
        }
      } catch (e) {
        console.error("Hydration error:", e);
        const first = newEmptyNote();
        setArchive([first]);
        setActiveId(first.id);
      }
      setHydrated(true);
    }
    loadData();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ════════════════ Persistence layer (bulletproof) ════════════════
  // Design principles:
  //   1. There is exactly ONE source of truth on disk: IndexedDB key
  //      `nota-enhance-archive`. Everything must end up there fast.
  //   2. Writes are direct: the moment we know the user edited something we
  //      build the latest archive and call setVal() right away — without
  //      waiting for a React render cycle. Speeding this up (vs the old
  //      "setArchive → useEffect → setVal" chain) closes the unload-before-
  //      commit window that bit us before.
  //   3. Multiple triggers: editor onUpdate, title/transcript/etc state
  //      changes, askMessages changes, autosave interval, beforeunload,
  //      pagehide, visibilitychange — every one of them ends up calling
  //      `persistNow()`. Redundant by design.
  //   4. No-op detection: persistNow compares against the last saved blob
  //      and skips IDB if identical. Cheap, avoids infinite write loops.
  //   5. Microtask scheduling: edit handlers schedule a flush on the next
  //      microtask (queueMicrotask) instead of debouncing 500ms — so even a
  //      reload one frame after typing catches the data in flight.

  // The latest persisted archive blob, kept as a ref so persistNow doesn't
  // need to live inside React's dependency graph.
  const lastPersistedRef = useRef<string>("");

  const buildLatestArchive = useCallback((): ArchivedNote[] => {
    if (!activeId) return archive;
    // Distinguish "editor mounted, content empty" ("") from "editor not
    // mounted yet" (undefined). The TiptapEditor is dynamic-imported so
    // notesRef.current can be null on a fast reload (initial sync fires
    // on `hydrated`, which can flip true before the editor finishes
    // mounting). If we coerced undefined to "" we'd overwrite the
    // freshly-hydrated note text with empty — which is exactly the bug
    // that was wiping note bodies but leaving titles intact (titles
    // live in React state, not the editor ref).
    const notesMdFresh = notesRef.current?.getMarkdown();
    let changed = false;
    const next = archive.map((n) => {
      if (n.id !== activeId) return n;
      const notesMd = notesMdFresh !== undefined ? notesMdFresh : n.notes;
      const sameContent =
        n.notes === notesMd &&
        n.transcript === transcript &&
        n.enhancedHtml === enhancedHtml &&
        n.title === title &&
        !!n.manualTitle === titleManual &&
        (n.splitRatio ?? DEFAULT_SPLIT) === splitRatio &&
        JSON.stringify(n.askMessages || []) === JSON.stringify(askMessages);
      if (sameContent) return n;
      changed = true;
      return {
        ...n,
        notes: notesMd,
        transcript,
        enhancedHtml,
        title,
        manualTitle: titleManual,
        splitRatio,
        askMessages,
        updatedAt: Date.now(),
      };
    });
    return changed ? next : archive;
  }, [activeId, archive, transcript, enhancedHtml, title, titleManual, splitRatio, askMessages]);

  // Direct, immediate persistence path — bypasses React state entirely.
  // Returns the (possibly updated) archive so callers can also push it into
  // React state when they want the UI to reflect the change.
  const persistNow = useCallback((): ArchivedNote[] => {
    if (!hydrated || !activeId) return archive;
    const next = buildLatestArchive();
    if (next === archive) return archive; // no actual change

    // Cheap dirty-check against the last write to absorb identical-state
    // ticks (e.g. autosave interval firing on a quiescent note).
    let serialized: string;
    try { serialized = JSON.stringify(next); } catch { serialized = ""; }
    if (serialized && serialized === lastPersistedRef.current) return next;
    lastPersistedRef.current = serialized;

    // Fire-and-forget IDB writes. Started synchronously — modern browsers
    // keep the transaction alive across unload long enough to commit.
    void setVal(STORAGE_KEY, next);
    void setVal(ACTIVE_ID_KEY, activeId);
    return next;
  }, [hydrated, activeId, archive, buildLatestArchive]);

  // The classic snapshot — pushes the latest into React state AND IDB.
  const snapshot = useCallback(() => {
    const next = persistNow();
    if (next !== archive) setArchive(next);
  }, [persistNow, archive]);

  // Microtask-scheduled flush. Used by hot paths (editor onChange) so the
  // write is initiated within ~0ms of the keystroke, not on a 500ms timer.
  const flushScheduledRef = useRef(false);
  const scheduleFlush = useCallback(() => {
    if (flushScheduledRef.current) return;
    flushScheduledRef.current = true;
    queueMicrotask(() => {
      flushScheduledRef.current = false;
      snapshot();
    });
  }, [snapshot]);

  // Editor-change handler: fire immediately on every Tiptap update.
  const handleEditorChange = useCallback(() => {
    scheduleFlush();
  }, [scheduleFlush]);

  // Belt-and-suspenders: persist whenever any tracked React state changes.
  // No debounce — we want it on disk before anything else can clear it.
  useEffect(() => {
    if (!hydrated) return;
    snapshot();
  }, [title, titleManual, transcript, enhancedHtml, splitRatio, askMessages, hydrated, snapshot]);

  // Steady-state autosave (1s). Catches in-editor edits that didn't fire
  // onUpdate for some reason (paste from formatted source, etc.).
  useEffect(() => {
    if (!hydrated) return;
    const id = setInterval(snapshot, 1000);
    return () => clearInterval(id);
  }, [snapshot, hydrated]);

  // Final sync write on every page-leave signal. `flushNow` runs the same
  // persistNow() above — guaranteed to start the IDB transaction before the
  // browser unloads the page.
  const flushNow = useCallback(() => { persistNow(); }, [persistNow]);

  useEffect(() => {
    const onHide = () => flushNow();
    window.addEventListener("beforeunload", onHide);
    window.addEventListener("pagehide", onHide);
    const onVis = () => { if (document.visibilityState === "hidden") flushNow(); };
    document.addEventListener("visibilitychange", onVis);
    return () => {
      window.removeEventListener("beforeunload", onHide);
      window.removeEventListener("pagehide", onHide);
      document.removeEventListener("visibilitychange", onVis);
    };
  }, [flushNow]);

  // ════════════════ Cross-device sync ════════════════
  //
  // Pull-and-push against /api/notes/sync. The server merges per-note by
  // updatedAt (last write wins) and applies tombstones, then echoes the
  // merged state back. We adopt that state for everything EXCEPT the active
  // note's editor content — overwriting what the user is currently typing
  // would feel terrible, and the active note's local copy is by definition
  // the freshest one anyway (it'll get pushed on the next sync).
  //
  // Triggers:
  //   1. After hydrate completes — pulls in whatever other devices wrote
  //      while this tab was closed, and uploads any local changes from
  //      while this tab was offline.
  //   2. Debounced after every snapshot — pushes local edits.
  //   3. On `visibilitychange` to visible / window focus — pulls fresh
  //      state. This is the only "incoming" path, so it doubles as
  //      cross-tab sync (switching tabs fires visibilitychange).

  const syncInFlightRef = useRef(false);
  const initialSyncDoneRef = useRef(false);
  const remoteSyncTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Signature of the last payload we successfully POSTed-and-adopted. Used
  // to dedup the auto-trigger feedback loop: every successful sync calls
  // setArchive(merged), which trips the `[archive, …]` useEffect, which
  // re-schedules a sync 2.5s later — and so on, forever, even when
  // nothing actually changed. Comparing against this ref skips the no-op
  // round-trip while still allowing visibility/focus PULL syncs through
  // (those carry isPull and bypass the check, see below).
  const lastSyncedSignatureRef = useRef<string>("");

  const tombstonesRef = useRef(tombstones);
  useEffect(() => { tombstonesRef.current = tombstones; }, [tombstones]);

  const activeIdRef = useRef(activeId);
  useEffect(() => { activeIdRef.current = activeId; }, [activeId]);

  const syncWithServer = useCallback(async (opts: { isInitial?: boolean; isPull?: boolean } = {}) => {
    if (syncInFlightRef.current) return;
    if (!hydrated) return;

    // Build the freshest payload the same way persistNow does — by reading
    // the editor markdown directly so in-flight typing is included.
    const liveArchive = buildLatestArchive();
    const currentTombstones = tombstonesRef.current;

    // Dedup auto-triggered syncs (state-change debounce): if nothing has
    // changed since the last successful sync, don't waste a round-trip.
    // isInitial and isPull (visibility/focus) bypass — those want the
    // remote-side updates even when local is identical.
    let signature = "";
    try {
      signature = JSON.stringify({ a: liveArchive, t: currentTombstones });
    } catch {}
    if (
      !opts.isInitial &&
      !opts.isPull &&
      signature &&
      signature === lastSyncedSignatureRef.current
    ) {
      return;
    }

    syncInFlightRef.current = true;
    try {
      const body = {
        archive: liveArchive,
        tombstones: currentTombstones,
      };
      const res = await fetch("/api/notes/sync", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      });
      if (!res.ok) {
        // Soft-fail: leave local state alone, retry on next trigger. We do
        // log to console so a real outage is visible during dev.
        console.warn("notes/sync failed", res.status);
        return;
      }
      const merged = (await res.json()) as {
        archive: ArchivedNote[];
        tombstones: Record<string, number>;
      };

      // Apply tombstones unconditionally (cheap, and they don't affect the
      // visible UI on their own).
      setTombstones(merged.tombstones || {});
      void setVal(TOMBSTONES_KEY, merged.tombstones || {});

      const mergedArchive = Array.isArray(merged.archive) ? merged.archive : [];
      const curActive = activeIdRef.current;
      // Use liveArchive (built from editor markdown above) — that's the
      // freshest local copy of the active note, ahead of React state if
      // the user is mid-keystroke.
      const localActive = curActive
        ? liveArchive.find((n) => n.id === curActive)
        : null;
      const remoteActive = curActive
        ? mergedArchive.find((n) => n.id === curActive)
        : null;

      // Decision: replace the entire archive, but on regular (non-initial)
      // syncs swap the active note's entry back to the local version so the
      // user's in-flight typing survives. The active note will be pushed on
      // the next sync, making it eventually consistent.
      let nextArchive = mergedArchive;
      if (!opts.isInitial && localActive && remoteActive) {
        nextArchive = mergedArchive.map((n) =>
          n.id === curActive ? localActive : n
        );
      }
      // If the active note was deleted on another device (tombstoned, so it
      // disappeared from the merged archive), pick a sibling or a new empty
      // one so the editor doesn't keep pointing at a ghost.
      if (curActive && !mergedArchive.some((n) => n.id === curActive)) {
        if (mergedArchive.length === 0) {
          const fresh = newEmptyNote();
          nextArchive = [fresh];
          setActiveId(fresh.id);
          setInitialNotesHtml("");
          setEnhancedHtml("");
          setTranscript("");
          setTitle("");
          setTitleManual(false);
          setSplitRatio(DEFAULT_SPLIT);
          setAskMessages([]);
          setNotesVersion((v) => v + 1);
          setEnhancedVersion((v) => v + 1);
        } else {
          const next = mergedArchive[0];
          setActiveId(next.id);
          setInitialNotesHtml(mdToHtml(next.notes));
          setEnhancedHtml(next.enhancedHtml || "");
          setTranscript(next.transcript || "");
          setTitle(next.title || "");
          setTitleManual(!!next.manualTitle);
          setSplitRatio(next.splitRatio ?? DEFAULT_SPLIT);
          setAskMessages(next.askMessages || []);
          setNotesVersion((v) => v + 1);
          setEnhancedVersion((v) => v + 1);
        }
      } else if (opts.isInitial && remoteActive && localActive) {
        // First sync of the session: if the server has a newer version of
        // the active note (e.g. user edited it on another device since this
        // tab last closed), reload the editors from it.
        if (remoteActive.updatedAt > localActive.updatedAt) {
          setInitialNotesHtml(mdToHtml(remoteActive.notes));
          setEnhancedHtml(remoteActive.enhancedHtml || "");
          setTranscript(remoteActive.transcript || "");
          setTitle(remoteActive.title || "");
          setTitleManual(!!remoteActive.manualTitle);
          setSplitRatio(remoteActive.splitRatio ?? DEFAULT_SPLIT);
          setAskMessages(remoteActive.askMessages || []);
          setNotesVersion((v) => v + 1);
          setEnhancedVersion((v) => v + 1);
        }
      }

      setArchive(nextArchive);
      void setVal(STORAGE_KEY, nextArchive);
      // Refresh dirty-check ref so the next persistNow doesn't undo this.
      try { lastPersistedRef.current = JSON.stringify(nextArchive); } catch {}
      // Record the signature of what's now in sync with the server, so
      // the auto-trigger dedup above can skip identical follow-up syncs.
      try {
        lastSyncedSignatureRef.current = JSON.stringify({
          a: nextArchive,
          t: merged.tombstones || {},
        });
      } catch {}
    } catch (err) {
      console.warn("notes/sync error", err);
    } finally {
      syncInFlightRef.current = false;
    }
    // setTranscript is exported by the audio hook and stable; the editor
    // refs are mutable refs, also stable.
  }, [hydrated, buildLatestArchive, setTranscript]);

  const scheduleRemoteSync = useCallback(() => {
    if (!hydrated) return;
    if (remoteSyncTimerRef.current) clearTimeout(remoteSyncTimerRef.current);
    remoteSyncTimerRef.current = setTimeout(() => {
      void syncWithServer();
    }, REMOTE_SYNC_DEBOUNCE_MS);
  }, [hydrated, syncWithServer]);

  // 1. Initial sync after hydrate finishes.
  useEffect(() => {
    if (!hydrated || initialSyncDoneRef.current) return;
    initialSyncDoneRef.current = true;
    void syncWithServer({ isInitial: true });
  }, [hydrated, syncWithServer]);

  // 2. Schedule a debounced push every time the local archive or
  //    tombstones change. The persistence layer above handles the local IDB
  //    writes; this only kicks the network leg.
  useEffect(() => {
    if (!hydrated) return;
    scheduleRemoteSync();
  }, [archive, tombstones, title, titleManual, transcript, enhancedHtml, splitRatio, askMessages, hydrated, scheduleRemoteSync]);

  // 3. Pull on tab visibility / window focus so cross-device updates are
  //    near-real-time (switching to this tab on the other device triggers a
  //    pull within ~one network round-trip). isPull=true bypasses the
  //    "nothing changed locally" dedup — we want the server's view even
  //    when the local archive is identical to what we last sent.
  useEffect(() => {
    if (!hydrated) return;
    const onFocus = () => { void syncWithServer({ isPull: true }); };
    const onVisible = () => {
      if (document.visibilityState === "visible") void syncWithServer({ isPull: true });
    };
    window.addEventListener("focus", onFocus);
    document.addEventListener("visibilitychange", onVisible);
    return () => {
      window.removeEventListener("focus", onFocus);
      document.removeEventListener("visibilitychange", onVisible);
    };
  }, [hydrated, syncWithServer]);

  // ── Note operations ──
  const handleSelectNote = useCallback(
    (id: string) => {
      if (id === activeId) return;
      snapshot();
      const target = archive.find((n) => n.id === id);
      if (!target) return;
      setActiveId(id);
      setInitialNotesHtml(mdToHtml(target.notes));
      setEnhancedHtml(target.enhancedHtml || "");
      setTranscript(target.transcript || "");
      setTitle(target.title || "");
      setTitleManual(!!target.manualTitle);
      setSplitRatio(target.splitRatio ?? DEFAULT_SPLIT);
      setAskMessages(target.askMessages || []);
      setNotesVersion((v) => v + 1);
      setEnhancedVersion((v) => v + 1);
    },
    [activeId, archive, snapshot, setTranscript]
  );

  const handleCreateNote = useCallback(() => {
    snapshot();
    const fresh = newEmptyNote();
    setArchive((prev) => [...prev, fresh]);
    setActiveId(fresh.id);
    setInitialNotesHtml("");
    setEnhancedHtml("");
    setTranscript("");
    setTitle("");
    setTitleManual(false);
    setSplitRatio(DEFAULT_SPLIT);
    setAskMessages([]);
    setNotesVersion((v) => v + 1);
    setEnhancedVersion((v) => v + 1);
  }, [snapshot, setTranscript]);

  const handleDeleteNote = useCallback(
    (id: string) => {
      // Record a tombstone so the delete propagates to other devices on the
      // next sync round-trip (without a tombstone, an old still-present copy
      // on another device would resurrect this note when it pushes).
      setTombstones((prev) => ({ ...prev, [id]: Date.now() }));
      setArchive((prev) => {
        const remaining = prev.filter((n) => n.id !== id);
        if (id === activeId) {
          if (remaining.length === 0) {
            const fresh = newEmptyNote();
            setActiveId(fresh.id);
            setInitialNotesHtml("");
            setEnhancedHtml("");
            setTranscript("");
            setTitle("");
            setTitleManual(false);
            setSplitRatio(DEFAULT_SPLIT);
            setNotesVersion((v) => v + 1);
            setEnhancedVersion((v) => v + 1);
            return [fresh];
          }
          const next = remaining[0];
          setActiveId(next.id);
          setInitialNotesHtml(mdToHtml(next.notes));
          setEnhancedHtml(next.enhancedHtml || "");
          setTranscript(next.transcript || "");
          setTitle(next.title || "");
          setTitleManual(!!next.manualTitle);
          setSplitRatio(next.splitRatio ?? DEFAULT_SPLIT);
          setAskMessages(next.askMessages || []);
          setNotesVersion((v) => v + 1);
          setEnhancedVersion((v) => v + 1);
        }
        return remaining;
      });
    },
    [activeId, setTranscript]
  );

  const handleTogglePin = useCallback((id: string) => {
    // Bump updatedAt — the server-side merge in lib/notes-store.ts uses
    // a strict `>` on updatedAt, so without a fresh timestamp the pinned
    // copy from this device would tie with whatever the server already
    // stored (unpinned, same updatedAt because pinning isn't a content
    // edit) and the merge'd keep the older entry → pin silently
    // reverted on the next pull.
    setArchive((prev) =>
      prev.map((n) =>
        n.id === id ? { ...n, pinned: !n.pinned, updatedAt: Date.now() } : n
      )
    );
  }, []);

  const handleTitleChange = (v: string) => { setTitle(v); setTitleManual(true); };

  const confirmEnhance = useCallback(async () => {
    setPromptModalOpen(false);
    let notes = notesRef.current?.getMarkdown() || "";
    const trans = transcript.trim();

    if (!includeImages) {
      notes = notes.replace(/!\[.*?\]\(data:image\/.*?\)/g, "[Immagine saltata]");
    }
    if (!includePdfs) {
      notes = notes.replace(/\[📎 .*?\]\(data:application\/pdf.*?\)/g, "[Documento PDF saltato]");
    }

    setIsEnhancing(true);
    setAppError(null);

    try {
      const res = await fetch("/api/enhance", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notes: notes || null,
          transcript: trans || null,
          instructions: enhanceInstructions.trim() || undefined,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Errore server");

      const html = mdToHtml(data.enhanced);
      setEnhancedHtml(html);
      if ((!titleManual || !title.trim()) && data.title) {
        setTitle(data.title);
        setTitleManual(false);
      }
      setEnhancedVersion((v) => v + 1);
      // Mobile only sees one pane at a time — surface the freshly-enhanced
      // result automatically so the user doesn't have to tap "Enhanced".
      setMobilePane("enhanced");
      // No explicit snapshot here: the belt-and-suspenders useEffect on
      // [title, enhancedHtml, …] picks up these state writes after React
      // commits and snapshot-s automatically. Calling snapshot() on a
      // setTimeout was racing with that commit (sometimes reading stale
      // state, sometimes overlapping a sync) — pure redundancy.
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Errore sconosciuto";
      setAppError(message);
    }

    setIsEnhancing(false);
  }, [transcript, titleManual, enhanceInstructions, includeImages, includePdfs, title]);

  const handleEnhance = useCallback(() => {
    const notes = notesRef.current?.getMarkdown() || "";
    const trans = transcript.trim();
    if (!notes && !trans) {
      setAppError("Scrivi note o registra audio prima.");
      return;
    }
    setPromptModalOpen(true);
  }, [transcript]);

  const handleImportClick = () => fileInputRef.current?.click();
  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = Array.from(e.target.files || []);
    e.target.value = "";
    if (files.length === 0) return;

    // Multi-file: prefix each transcribed block with `=== filename ===`
    // so the user can scroll through the transcript and tell pieces
    // apart. Single-file: skip the label (one block, label would be
    // visual noise).
    const multi = files.length > 1;
    for (const file of files) {
      if (file.size > 25 * 1024 * 1024) {
        setAppError(
          `Il file "${file.name}" pesa troppo (>${Math.round(file.size / 1024 / 1024)} MB). Limite Groq Whisper: 25 MB.`
        );
        continue;
      }
      const label = multi ? `=== ${file.name} ===` : undefined;
      // Sequential await so the transcript blocks land in user-picked
      // order. Parallel uploads would race and shuffle them.
      await importAudio(file, label);
    }
  };

  const handleStartRec = async () => { await startRecording(); };

  const toggleTheme = useCallback(() => {
    const cur = document.documentElement.getAttribute("data-theme") || "dark";
    const next = cur === "dark" ? "light" : "dark";
    document.documentElement.setAttribute("data-theme", next);
    try { localStorage.setItem("nota-theme", next); } catch {}
  }, []);

  // ── Plain-text extraction from enhanced HTML for Ask AI context ──
  const enhancedPlain = useMemo(() => {
    if (!enhancedHtml) return "";
    if (typeof window === "undefined") return "";
    const tmp = document.createElement("div");
    tmp.innerHTML = enhancedHtml;
    return (tmp.textContent || "").trim();
  }, [enhancedHtml]);

  // The Ask AI context is BOTH the enhanced note AND the raw transcript
  // (when available). Each is labelled so the model can prefer the more
  // structured enhanced version while still being able to look up details
  // that survive only in the raw transcription.
  const askContext = useMemo(() => {
    const transClean = transcript.trim();
    const parts: string[] = [];
    if (enhancedPlain) parts.push(`### NOTA ENHANCED\n${enhancedPlain}`);
    if (transClean) parts.push(`### TRASCRIZIONE COMPLETA\n${transClean}`);
    return parts.join("\n\n");
  }, [enhancedPlain, transcript]);
  const askAvailable = !!askContext;

  const sendAsk = useCallback(async () => {
    const q = askInput.trim();
    if (!q || askLoading) return;
    if (!askAvailable) {
      setAppError("Servono almeno una nota enhanced o una trascrizione per fare domande.");
      return;
    }
    const next: AskMsg[] = [...askMessages, { role: "user", content: q }];
    setAskMessages(next);
    setAskInput("");
    setAskLoading(true);
    try {
      const res = await fetch("/api/ask", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          question: q,
          context: askContext,
          history: askMessages,
        }),
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Errore Ask AI");
      setAskMessages([...next, { role: "assistant", content: data.answer }]);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : "Errore Ask AI";
      setAskMessages([...next, { role: "assistant", content: `⚠️ ${message}` }]);
    } finally {
      setAskLoading(false);
    }
  }, [askInput, askLoading, askMessages, askAvailable, askContext]);

  // ── PDF export via iframe + window.print() ──
  // L'utente ottiene il dialogo di stampa di Safari (Save as PDF). Ho provato
  // html2pdf.js ma produceva PDF vuoti (problemi di interazione tra
  // html2canvas e il `zoom: 1.15` globale).
  const exportPdf = useCallback(() => {
    try {
      snapshot();
      const notesHtml = mdToHtml(notesRef.current?.getMarkdown() || "");
      const titleSafe = (title || "Nota").replace(/[<>]/g, "");
      const created = new Date().toLocaleString("it-IT", {
        day: "2-digit", month: "long", year: "numeric", hour: "2-digit", minute: "2-digit",
      });

      if (!notesHtml && !enhancedHtml) {
        setAppError("Niente da esportare: la nota è vuota.");
        return;
      }

      // Self-contained CSS. We tried extracting `document.styleSheets` from
      // the parent page so the print iframe inherited Tiptap + Tailwind
      // styling automatically — but that pulled in problematic globals
      // (mobile @media `html, body { overflow:hidden; height:100dvh }`,
      // the 1.15× zoom, theme transitions) that interacted badly with the
      // print layer and produced blank pages on mobile. Inline only what
      // we actually need to render the document at A4.
      const printCss = `
        * { box-sizing: border-box; }
        html, body {
          margin: 0; padding: 0;
          background: #ffffff; color: #1c1917;
          -webkit-print-color-adjust: exact;
          print-color-adjust: exact;
        }
        @page { size: A4; margin: 18mm; }
        .pdf-export-root {
          font-family: "IBM Plex Sans", system-ui, -apple-system, sans-serif;
          color: #1c1917;
          background: #ffffff;
          padding: 0;
          line-height: 1.5;
          font-size: 13.5px;
        }
        .pdf-export-root h1 { font-size: 26px; font-weight: 700; margin: 0 0 18px; letter-spacing: -0.02em; }
        .pdf-export-root h2 { font-size: 18px; font-weight: 600; margin: 22px 0 8px; letter-spacing: -0.01em; }
        .pdf-export-root h3 { font-size: 15px; font-weight: 600; margin: 16px 0 6px; }
        .pdf-export-root p { margin: 6px 0; }
        .pdf-export-root ul { padding-left: 20px; margin: 8px 0; list-style: disc; }
        .pdf-export-root li { margin: 3px 0; }
        .pdf-export-root strong { font-weight: 600; color: #0c0a09; }
        .pdf-export-root em { font-style: italic; }
        .pdf-export-root u { text-decoration: underline; text-decoration-thickness: 1.5px; text-underline-offset: 2px; }
        .pdf-export-root mark, .pdf-export-root .hl-hermes {
          background: transparent; color: #A84309; font-weight: 600;
        }
        .pdf-export-root blockquote {
          border-left: 2px solid rgba(168, 67, 9, 0.45);
          padding-left: 12px; margin: 8px 0; font-style: italic;
          color: #44403c; font-size: 12.5px;
        }
        .pdf-export-root img,
        .pdf-export-root img[data-size],
        .pdf-export-root img[data-size="large"],
        .pdf-export-root img[data-size="small"] {
          max-width: 220px !important;
          height: auto;
          display: block;
          margin: 10px 0;
          border-radius: 6px;
        }
        .pdf-export-root .pdf-meta {
          font-family: "IBM Plex Mono", ui-monospace, monospace;
          font-size: 10.5px;
          color: #78716c;
          margin-bottom: 18px;
          letter-spacing: 0.04em;
        }
        .pdf-export-root .pdf-section-label {
          font-family: "IBM Plex Mono", ui-monospace, monospace;
          font-size: 9.5px;
          font-weight: 600;
          text-transform: uppercase;
          letter-spacing: 0.18em;
          color: #A84309;
          margin: 28px 0 10px;
          border-bottom: 1px solid rgba(0,0,0,0.08);
          padding-bottom: 4px;
        }
        .pdf-export-root .file-chip {
          display: inline-flex; align-items: center; gap: 8px;
          padding: 6px 10px; border: 1px solid rgba(0,0,0,0.1); border-radius: 8px;
          font-size: 11.5px; color: #1c1917; text-decoration: none;
        }
      `;

      const body = `
        <div class="pdf-export-root">
          <h1>${titleSafe}</h1>
          <div class="pdf-meta">${created}</div>
          ${notesHtml ? `<div class="pdf-section-label">Note</div>${notesHtml}` : ""}
          ${enhancedHtml ? `<div class="pdf-section-label">Enhanced</div>${enhancedHtml}` : ""}
        </div>
      `;

      const docHtml = `<!doctype html><html><head><meta charset="utf-8"><title>${titleSafe}</title><style>${printCss}</style></head><body>${body}</body></html>`;

      const iframe = document.createElement("iframe");
      iframe.setAttribute("aria-hidden", "true");
      // Real (non-zero) dimensions positioned off-screen.
      // 0×0 + opacity:0 caused Safari and Chrome to skip layout/paint of
      // the iframe document, and `contentWindow.print()` then printed a
      // blank page. Giving it real width/height while keeping it visually
      // hidden (left:-10000px) restores layout without showing a flash.
      iframe.style.position = "fixed";
      iframe.style.left = "-10000px";
      iframe.style.top = "0";
      iframe.style.width = "210mm";  // A4 width — matches @page in pdf-export-root
      iframe.style.height = "297mm";
      iframe.style.border = "0";
      iframe.style.opacity = "1";
      iframe.style.pointerEvents = "none";

      // Load via srcdoc — fires a reliable `load` event in every browser.
      iframe.srcdoc = docHtml;

      const triggerPrint = () => {
        const win = iframe.contentWindow;
        if (!win) {
          console.error("PDF: contentWindow null");
          setAppError("Impossibile aprire la finestra di stampa.");
          return;
        }
        const doPrint = () => {
          try {
            win.focus();
            win.print();
          } catch (e) {
            console.error("PDF print error:", e);
            setAppError("Errore durante la stampa PDF.");
          }
        };
        // Wait for fonts AND the next paint frame. Without the rAF some
        // browsers (Safari especially) trigger print before first layout
        // pass, producing the same blank page. Double-rAF is overkill but
        // costs only a few ms.
        const win2 = win as Window & { requestAnimationFrame?: (cb: () => void) => void };
        const afterPaint = () => {
          win2.requestAnimationFrame?.(() => win2.requestAnimationFrame?.(doPrint) ?? doPrint());
        };
        const fonts = (win.document as Document & { fonts?: { ready: Promise<unknown> } }).fonts;
        if (fonts?.ready) fonts.ready.then(afterPaint, afterPaint);
        else afterPaint();

        // Clean up the iframe a bit later — Safari surfaces the dialog
        // asynchronously; remove too soon and the print job is cancelled.
        setTimeout(() => {
          try { document.body.removeChild(iframe); } catch {}
        }, 6000);
      };

      iframe.addEventListener("load", triggerPrint, { once: true });
      document.body.appendChild(iframe);
    } catch (e) {
      console.error("PDF export failed:", e);
      setAppError("Esportazione PDF fallita: " + (e instanceof Error ? e.message : "errore sconosciuto"));
    }
  }, [enhancedHtml, snapshot, title]);

  // ── Global keyboard shortcuts (customizable via Settings) ──
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const inEditor = !!target && (
        target.isContentEditable ||
        target.tagName === "INPUT" ||
        target.tagName === "TEXTAREA"
      );

      if (matchesShortcut(e, shortcuts.palette)) {
        e.preventDefault();
        setPaletteOpen((p) => !p);
        return;
      }
      if (matchesShortcut(e, shortcuts.settings)) {
        e.preventDefault();
        setSettingsOpen((s) => !s);
        return;
      }
      if (matchesShortcut(e, shortcuts.enhance)) {
        e.preventDefault();
        if (!isEnhancing && !isRecording) handleEnhance();
        return;
      }
      if (inEditor) return;

      if (matchesShortcut(e, shortcuts.sidebar)) {
        e.preventDefault();
        setSidebarOpen((s) => !s);
        return;
      }
      if (matchesShortcut(e, shortcuts.newNote)) {
        e.preventDefault();
        handleCreateNote();
        return;
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isEnhancing, isRecording, handleEnhance, handleCreateNote, shortcuts]);

  if (!hydrated) {
    return <div className="h-dvh flex items-center justify-center text-text-muted text-sm">Caricamento…</div>;
  }

  const activeNote = archive.find((n) => n.id === activeId);
  const recordingBusy = isRecording || isTranscribingRecording;

  return (
    // h-dvh (dynamic viewport) instead of h-screen so iOS Safari's
    // collapsing URL bar doesn't push the action bar below the visible area.
    // Combined with body { overflow: hidden } on mobile (globals.css), this
    // means: zero outer scroll, only the editors and transcript drawer
    // scroll internally. The mobile pb reserves space for the fixed action
    // bar (which is pulled out of the flex flow on small to dodge dvh
    // reporting bugs in iOS standalone PWA mode).
    <div className="h-dvh flex flex-col bg-surface-0 relative overflow-hidden pb-[calc(env(safe-area-inset-bottom)+3.25rem)] md:pb-0">

      {/* ── Floating header (translucent) ── */}
      <header className="material-thin border-b shrink-0 z-30 pt-safe">
        <div className="flex items-center gap-2 md:gap-3 px-3 md:px-4 py-2 md:py-3">
          <button
            onMouseEnter={handleSidebarHoverEnter}
            onMouseLeave={handleSidebarHoverLeave}
            onClick={() => setSidebarOpen((s) => !s)}
            title={`Apri/chiudi sidebar (${formatShortcut(shortcuts.sidebar)})`}
            className="press w-10 h-10 md:w-9 md:h-9 flex items-center justify-center rounded-lg hover:bg-surface-3/50 text-text-secondary hover:text-text-primary"
          >
            <PanelLeft size={18} />
          </button>

          <div className="flex items-center gap-2 text-[12px] text-text-muted">
            <span className="font-bold text-text-primary tracking-tight">nota</span>
            <span className="text-accent opacity-50">/</span>
            <span className="text-accent tracking-tight font-medium">enhance</span>
          </div>

          <div className="flex-1" />

          {isRecording && (
            <div className="flex items-center gap-2 h-8 px-2.5 md:px-3 rounded-full bg-rec/10 border border-rec/30">
              <span className="live-dot" />
              <span className="text-[11px] text-rec font-mono tabular-nums">{formatTime(recordTime)}</span>
              <div className="hidden md:block w-16 h-5">
                <AudioWaveform getAnalyser={getAnalyser} active={isRecording} bars={16} color="#D4403D" />
              </div>
            </div>
          )}
          {isTranscribingRecording && !isRecording && (
            <div className="flex items-center gap-2 h-8 px-2.5 md:px-3 rounded-full bg-accent/10 border border-accent/30 text-accent">
              <Loader2 size={11} className="animate-spin-fast" />
              <span className="text-[11px] font-medium hidden sm:inline">Trascrivo registrazione…</span>
              <span className="text-[11px] font-medium sm:hidden">Trascrivo…</span>
            </div>
          )}
          {isTranscribingFile && (
            <div className="flex items-center gap-2 h-8 px-2.5 md:px-3 rounded-full bg-accent/10 border border-accent/30 text-accent">
              <Loader2 size={11} className="animate-spin-fast" />
              <span className="text-[11px] font-medium hidden sm:inline">Trascrivo file…</span>
              <span className="text-[11px] font-medium sm:hidden">File…</span>
            </div>
          )}

          {/* Audio player: hidden on phones (the action bar's stop control gives
              access to the recording flow, and the player is too wide to fit). */}
          {audioURL && (
            <audio controls src={audioURL} className="hidden md:block h-8 opacity-70" style={{ maxWidth: 240 }} />
          )}

          <button
            onClick={() => setPaletteOpen(true)}
            title={`Cerca (${formatShortcut(shortcuts.palette)})`}
            className="press flex items-center justify-center gap-2 w-10 h-10 md:w-auto md:h-8 md:px-3 rounded-lg bg-surface-2/60 hover:bg-surface-3/70 text-text-secondary hover:text-text-primary text-[12px]"
          >
            <Search size={16} className="md:hidden" />
            <span className="hidden md:inline">Cerca</span>
            <span className="hidden md:inline font-mono text-[10px] text-text-faint border border-[var(--material-border)] rounded px-1.5 py-0.5">{formatShortcut(shortcuts.palette)}</span>
          </button>
        </div>
      </header>

      {/* ── Title row ── */}
      <div className="px-4 md:px-10 pt-4 md:pt-8 pb-2 md:pb-3 shrink-0">
        <input
          type="text"
          value={title}
          onChange={(e) => handleTitleChange(e.target.value)}
          placeholder="Titolo della nota…"
          className="title-input"
        />
        <div className="flex items-center gap-3 mt-1.5 text-[11px] text-text-faint font-mono">
          <span>
            {activeNote && new Date(activeNote.createdAt)
              .toLocaleString("it-IT", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" })}
          </span>
          {importedFileName && !isTranscribingFile && (
            <span className="truncate max-w-[160px] md:max-w-[260px]">📁 {importedFileName}</span>
          )}
        </div>
      </div>

      {/* ── Mobile pane switcher (Notes ↔ Enhanced) ──
          Below md the side-by-side editors collapse into a tab switcher: only
          one pane is on screen at a time. Desktop hides this row entirely. */}
      <div className="md:hidden px-4 pb-2 shrink-0">
        <div className="material-regular border rounded-full p-0.5 flex">
          <button
            onClick={() => setMobilePane("notes")}
            className={`flex-1 h-9 rounded-full text-[12px] font-medium tracking-tight transition-colors ${
              mobilePane === "notes"
                ? "bg-surface-3/80 text-text-emphasis shadow-soft"
                : "text-text-secondary"
            }`}
          >
            Note
          </button>
          <button
            onClick={() => setMobilePane("enhanced")}
            className={`flex-1 h-9 rounded-full text-[12px] font-medium tracking-tight transition-colors flex items-center justify-center gap-1.5 ${
              mobilePane === "enhanced"
                ? "bg-surface-3/80 text-accent shadow-soft"
                : "text-text-secondary"
            }`}
          >
            <Sparkles size={11} />
            Enhanced
          </button>
        </div>
      </div>

      {/* ── Two-column content with draggable divider (desktop) /
            single-pane tab view (mobile) ── */}
      <div ref={splitContainerRef} className="flex-1 flex min-h-0 px-4 md:px-10 select-none">
        {/* LEFT: Notes — desktop uses splitRatio (via the --split-basis CSS
            var so we don't hardcode flex-basis as an inline style that would
            also apply on mobile); mobile gets `flex-1` and full width because
            only one pane is visible at a time. */}
        <div
          className={`flex-col min-h-0 animate-fade-in min-w-0 md:flex md:basis-[var(--split-basis)] md:grow-0 md:shrink-0 ${
            mobilePane === "notes" ? "flex flex-1" : "hidden"
          }`}
          style={{ ["--split-basis" as string]: `${splitRatio * 100}%` }}
        >
          <div className="hidden md:flex items-center justify-between mb-3 shrink-0">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted">
              Note
            </span>
          </div>
          <div className="flex-1 overflow-y-auto min-h-0 pr-0 md:pr-5 scrollbar-hidden">
            <TiptapEditor
              key={`notes-${activeId}-${notesVersion}`}
              ref={notesRef}
              placeholder="Inizia a scrivere…"
              initialContent={initialNotesHtml}
              onChange={handleEditorChange}
            />
          </div>
        </div>

        {/* DIVIDER — desktop only (CSS hides on mobile). */}
        <div
          role="separator"
          aria-orientation="vertical"
          tabIndex={0}
          onMouseDown={(e) => {
            e.preventDefault();
            setIsDraggingSplit(true);
            const container = splitContainerRef.current;
            if (!container) return;
            const rect = container.getBoundingClientRect();
            // Capture starting cursor X and current split ratio. We then move
            // the divider by DELTA (cursor delta / container width) instead of
            // recomputing from the absolute cursor position. This kills the
            // snap-jump that used to happen on the first mousemove: the
            // handle has horizontal margins (mx-4 = 16px), so the cursor X is
            // never exactly at `splitRatio * rect.width`, and the absolute
            // formula would yank the divider to the cursor on the first move.
            const startX = e.clientX;
            const startRatio = splitRatio;
            const move = (ev: MouseEvent) => {
              const dx = ev.clientX - startX;
              const ratio = Math.min(0.85, Math.max(0.15, startRatio + dx / rect.width));
              setSplitRatio(ratio);
            };
            const up = () => {
              setIsDraggingSplit(false);
              document.removeEventListener("mousemove", move);
              document.removeEventListener("mouseup", up);
              document.body.style.cursor = "";
            };
            document.body.style.cursor = "col-resize";
            document.addEventListener("mousemove", move);
            document.addEventListener("mouseup", up);
          }}
          onDoubleClick={() => setSplitRatio(DEFAULT_SPLIT)}
          onKeyDown={(e) => {
            if (e.key === "ArrowLeft") setSplitRatio((r) => Math.max(0.15, r - 0.02));
            if (e.key === "ArrowRight") setSplitRatio((r) => Math.min(0.85, r + 0.02));
          }}
          className={`split-handle mx-4 my-2 rounded-full ${isDraggingSplit ? "dragging" : ""}`}
          title="Trascina per ridimensionare. Doppio click per centrare."
        />

        {/* RIGHT: Enhanced */}
        <div
          className={`flex-col min-h-0 animate-fade-in min-w-0 md:flex md:flex-1 ${
            mobilePane === "enhanced" ? "flex flex-1" : "hidden"
          }`}
        >
          <div className="hidden md:flex items-center justify-between mb-3 shrink-0">
            <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-accent flex items-center gap-1.5">
              <Sparkles size={11} /> Enhanced
            </span>
            {askAvailable && (
              <button
                onClick={() => setAskOpen(true)}
                title="Fai una domanda — usa nota enhanced + trascrizione come contesto"
                className="press text-[10px] font-semibold uppercase tracking-[0.14em] text-text-muted hover:text-accent flex items-center gap-1.5"
              >
                <MessageCircle size={11} /> Ask AI
              </button>
            )}
          </div>
          <div className="flex-1 overflow-y-auto min-h-0 pl-0 md:pl-5 scrollbar-hidden">
            {isEnhancing ? (
              <div className="flex flex-col items-center justify-center h-full gap-4">
                <div className="relative w-10 h-10">
                  <div className="absolute inset-0 rounded-full border-2 border-surface-3" />
                  <div className="absolute inset-0 rounded-full border-2 border-transparent border-t-accent animate-spin-fast" />
                </div>
                <span className="text-xs text-text-muted">Sto elaborando…</span>
              </div>
            ) : enhancedHtml ? (
              <TiptapEditor
                key={`enhanced-${activeId}-${enhancedVersion}`}
                ref={enhancedRef}
                initialContent={enhancedHtml}
              />
            ) : (
              <EmptyState />
            )}
          </div>
        </div>
      </div>

      {/* ── Transcript drawer (click to open/close) ── */}
      <motion.div
        layout
        transition={{ type: "spring", stiffness: 380, damping: 32, mass: 0.7 }}
        className="mx-4 md:mx-10 mt-3 md:mt-4 mb-1 md:mb-3 rounded-2xl material-regular border shadow-soft overflow-hidden shrink-0"
      >
        <button
          type="button"
          onClick={() => setShowTranscript((s) => !s)}
          className="w-full px-4 md:px-5 py-2.5 flex items-center gap-3 text-left hover:bg-surface-2/30 transition-colors"
        >
          <span className="text-[10px] font-semibold uppercase tracking-[0.18em] text-text-muted flex items-center gap-2 shrink-0">
            🎙️ Trascrizione
            {transcript && (
              <span className="text-text-faint font-mono normal-case tracking-normal">
                · {transcript.length} car.
              </span>
            )}
          </span>

          {!showTranscript && transcript && (
            <span
              className="hidden sm:inline flex-1 min-w-0 text-[12px] text-text-secondary truncate text-right font-mono italic"
              title={transcript}
            >
              {transcript.slice(-140).replace(/\s+/g, " ").trim()}
            </span>
          )}
          {!showTranscript && !transcript && isRecording && (
            <span className="flex-1 min-w-0 text-[12px] text-text-faint italic text-right">
              <span className="hidden sm:inline">Registrazione in corso… (la trascrizione apparirà al termine)</span>
              <span className="sm:hidden">Registrando…</span>
            </span>
          )}

          <motion.span
            animate={{ rotate: showTranscript ? 180 : 0 }}
            transition={{ type: "spring", stiffness: 400, damping: 28 }}
            className="text-text-faint inline-flex shrink-0"
          >
            <ChevronUp size={14} />
          </motion.span>
        </button>
        <AnimatePresence initial={false}>
          {showTranscript && (
            <motion.div
              key="textarea"
              initial={{ height: 0, opacity: 0 }}
              animate={{ height: "auto", opacity: 1 }}
              exit={{ height: 0, opacity: 0 }}
              transition={{ type: "spring", stiffness: 380, damping: 34, mass: 0.7 }}
              style={{ overflow: "hidden" }}
            >
              <textarea
                value={transcript}
                onChange={(e) => setTranscript(e.target.value)}
                placeholder="Trascrizione (al termine della registrazione), file audio importato, o testo incollato…"
                className="w-full h-28 md:h-32 bg-transparent border-none outline-none resize-none px-4 md:px-5 py-3 text-[13px] leading-relaxed text-text-secondary font-mono"
              />
            </motion.div>
          )}
        </AnimatePresence>
      </motion.div>

      {/* ── Floating action bar (sleek, icon-forward) ──
          Mobile: edge-to-edge pill, labels hidden on the secondary buttons
          (Importa, PDF, Ask) so the primary Rec / Enhance keep their text;
          tap targets stay ≥40px tall via h-10 on small.

          On mobile the wrapper is pulled out of the flex flow with
          position:fixed pinned to bottom:0. This sidesteps an iOS
          standalone-PWA bug where 100dvh sometimes reports a value
          smaller than the actual visible viewport, leaving phantom space
          below an in-flow bar. The root container reserves matching
          padding-bottom so the editor / transcript don't slide under the
          fixed bar. Desktop keeps the in-flow `shrink-0` layout. */}
      <div className="fixed bottom-0 left-0 right-0 z-20 md:static md:z-auto md:shrink-0 px-3 md:px-10 pb-safe md:pb-4">
        <div className="material-regular border rounded-full shadow-float px-1.5 md:px-2 py-1 md:py-1.5 flex items-center justify-center gap-0.5 md:gap-1 mx-auto w-full md:w-fit max-w-full overflow-x-auto scrollbar-hidden">
          <button
            onClick={handleImportClick}
            disabled={isTranscribingFile}
            className="press flex items-center gap-1.5 h-10 md:h-8 px-3 rounded-full hover:bg-surface-3/60 disabled:opacity-50 text-text-secondary hover:text-text-primary text-[12px] font-medium shrink-0"
            title="Importa file audio"
          >
            {isTranscribingFile ? <Loader2 size={15} className="animate-spin-fast" /> : <Download size={15} />}
            <span className="hidden md:inline">Importa</span>
          </button>

          <div className="w-px h-5 bg-[var(--material-border)]" />

          {!isRecording ? (
            <button
              onClick={handleStartRec}
              disabled={isEnhancing || isTranscribingRecording}
              className="btn-premium-rec press flex items-center gap-1.5 h-10 md:h-8 px-3.5 rounded-full text-white text-[12px] font-medium tracking-tight disabled:opacity-50 shrink-0"
              title="Registra"
            >
              <span className="w-1.5 h-1.5 rounded-full bg-white/95 shadow-[0_0_4px_rgba(255,255,255,0.6)]" />
              {isTranscribingRecording ? "Trascrivo…" : "Registra"}
            </button>
          ) : (
            <button
              onClick={stopRecording}
              className="press flex items-center gap-2 h-10 md:h-8 px-3.5 rounded-full bg-rec/15 border border-rec/40 text-rec text-[12px] font-medium tracking-tight shrink-0"
            >
              <Square size={9} fill="currentColor" />
              Stop · <span className="font-mono tabular-nums">{formatTime(recordTime)}</span>
            </button>
          )}

          <div className="w-px h-5 bg-[var(--material-border)]" />

          <button
            onClick={handleEnhance}
            disabled={isEnhancing || recordingBusy}
            className="btn-premium-accent press flex items-center gap-1.5 h-10 md:h-8 px-3.5 rounded-full text-white text-[12px] font-medium tracking-tight disabled:opacity-50 shrink-0"
            title={`Enhance (${formatShortcut(shortcuts.enhance)})`}
          >
            <Sparkles size={13} strokeWidth={2.2} />
            {isEnhancing ? "Elaborando…" : "Enhance"}
          </button>

          <div className="w-px h-5 bg-[var(--material-border)]" />

          <button
            onClick={exportPdf}
            disabled={!title && !enhancedHtml}
            title="Esporta nota + enhanced in PDF"
            className="press flex items-center gap-1.5 h-10 md:h-8 px-3 rounded-full hover:bg-surface-3/60 disabled:opacity-30 text-text-secondary hover:text-text-primary text-[12px] font-medium shrink-0"
          >
            <FileDown size={15} />
            <span className="hidden md:inline">PDF</span>
          </button>

          <button
            onClick={() => setAskOpen(true)}
            disabled={!askAvailable}
            title="Ask AI — domande sul contenuto (nota enhanced + trascrizione)"
            className="press flex items-center gap-1.5 h-10 md:h-8 px-3 rounded-full hover:bg-surface-3/60 disabled:opacity-30 text-text-secondary hover:text-accent text-[12px] font-medium shrink-0"
          >
            <MessageCircle size={15} />
            <span className="hidden md:inline">Ask</span>
          </button>

          <input
            ref={fileInputRef}
            type="file"
            multiple
            accept="audio/*,.mp3,.m4a,.aac,.wav,.webm,.ogg,.opus,.flac"
            onChange={handleFileChange}
            className="hidden"
          />
        </div>
      </div>

      {/* ── Floating sidebar ── */}
      <NotesSidebar
        notes={archive}
        activeId={activeId}
        open={sidebarOpen}
        onClose={() => setSidebarOpen(false)}
        onSelect={(id) => { handleSelectNote(id); setSidebarOpen(false); }}
        onCreate={() => { handleCreateNote(); setSidebarOpen(false); }}
        onDelete={handleDeleteNote}
        onTogglePin={handleTogglePin}
        onOpenCommandPalette={() => setPaletteOpen(true)}
        onLogout={handleLogout}
        username={username}
        onMouseEnter={handleSidebarHoverEnter}
        onMouseLeave={handleSidebarHoverLeave}
      />

      {/* ── Command palette ── */}
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        notes={archive}
        onSelectNote={handleSelectNote}
        onCreate={handleCreateNote}
        onStartRecord={handleStartRec}
        onImport={handleImportClick}
        onEnhance={handleEnhance}
        onToggleTheme={toggleTheme}
        onOpenSettings={() => setSettingsOpen(true)}
        enhanceShortcut={formatShortcut(shortcuts.enhance)}
      />

      {/* ── Settings modal ── */}
      <SettingsModal
        open={settingsOpen}
        onClose={() => setSettingsOpen(false)}
        shortcuts={shortcuts}
        onChange={updateShortcuts}
      />

      {/* ── Enhance Prompt Modal ── */}
      <AnimatePresence>
        {promptModalOpen && (
          <div className="fixed inset-0 z-[60] flex items-end sm:items-center justify-center px-3 sm:px-4 pb-safe">
            <motion.div
              className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
              onClick={() => setPromptModalOpen(false)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            />
            <motion.div
              className="relative w-full max-w-lg rounded-2xl material-thick shadow-float border p-4 sm:p-5 overflow-hidden flex flex-col mb-2 sm:mb-0 max-h-[92vh] overflow-y-auto"
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 4 }}
              transition={{ type: "spring", stiffness: 420, damping: 30 }}
            >
              <div className="flex items-center gap-2 mb-3">
                <Sparkles size={16} className="text-accent" />
                <h3 className="text-[15px] font-semibold text-text-emphasis tracking-tight">Istruzioni Aggiuntive</h3>
              </div>
              <p className="text-[13px] text-text-secondary leading-relaxed mb-4">
                Vuoi dare un focus specifico al riassunto? Scrivi qui istruzioni personalizzate per l&apos;AI <span className="italic text-text-faint">(opzionale)</span>.
              </p>

              <textarea
                value={enhanceInstructions}
                onChange={(e) => setEnhanceInstructions(e.target.value)}
                placeholder="Es. 'Fai una lista delle definizioni chiave', 'Ignora le digressioni storiche', 'Traduci i terminologismi'..."
                className="w-full h-32 bg-surface-2/50 border border-[var(--material-border)] focus:border-accent/40 rounded-xl outline-none resize-none px-4 py-3 text-[13px] leading-relaxed text-text-primary placeholder:text-text-muted/60 transition-colors"
                autoFocus
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    confirmEnhance();
                  }
                }}
              />
              <div className="flex flex-col gap-2.5 mt-3 mb-1 px-1">
                <label className="flex items-center gap-2.5 text-[12px] text-text-secondary cursor-pointer hover:text-text-primary transition-colors select-none">
                  <input type="checkbox" checked={includeImages} onChange={e => setIncludeImages(e.target.checked)} className="accent-accent w-3.5 h-3.5" />
                  Includi Immagini
                </label>
                <label className="flex items-center gap-2.5 text-[12px] text-text-secondary cursor-pointer hover:text-text-primary transition-colors select-none">
                  <input type="checkbox" checked={includePdfs} onChange={e => setIncludePdfs(e.target.checked)} className="accent-accent w-3.5 h-3.5" />
                  Includi documenti PDF allegati
                </label>
              </div>

              <div className="flex flex-col-reverse sm:flex-row sm:items-center sm:justify-between gap-3 mt-4">
                <span className="hidden sm:inline text-[10px] text-text-faint font-mono">Premi ⌘+Invio per confermare</span>
                <div className="flex gap-3 sm:flex-row flex-row-reverse">
                  <button
                    onClick={() => setPromptModalOpen(false)}
                    className="press flex-1 sm:flex-initial px-4 py-2.5 sm:py-2 rounded-xl text-[13px] font-medium text-text-muted hover:text-text-primary hover:bg-surface-3/60 transition-colors"
                  >
                    Annulla
                  </button>
                  <button
                    onClick={confirmEnhance}
                    className="btn-premium-accent press flex-1 sm:flex-initial px-4 py-2.5 sm:py-2 rounded-xl text-[13px] font-medium tracking-tight text-white"
                  >
                    Procedi all&apos;Enhance
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Ask AI modal ── */}
      <AnimatePresence>
        {askOpen && (
          <div className="fixed inset-0 z-[60] flex items-stretch sm:items-center justify-center sm:px-4">
            <motion.div
              className="absolute inset-0 bg-black/40 backdrop-blur-[2px]"
              onClick={() => setAskOpen(false)}
              initial={{ opacity: 0 }}
              animate={{ opacity: 1 }}
              exit={{ opacity: 0 }}
              transition={{ duration: 0.15 }}
            />
            <motion.div
              className="relative w-full max-w-xl h-full sm:h-[70vh] rounded-none sm:rounded-2xl material-thick shadow-float sm:border overflow-hidden flex flex-col pt-safe pb-safe"
              initial={{ opacity: 0, scale: 0.96, y: 8 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.96, y: 4 }}
              transition={{ type: "spring", stiffness: 420, damping: 30 }}
            >
              <div className="flex items-center gap-2 px-4 sm:px-5 pt-3 sm:pt-4 pb-3 border-b border-[var(--material-border)]">
                <MessageCircle size={15} className="text-accent shrink-0" />
                <h3 className="text-[14px] font-semibold text-text-emphasis tracking-tight">Ask AI</h3>
                <span className="hidden sm:inline text-[11px] text-text-faint truncate">
                  — contesto: {enhancedPlain && transcript.trim()
                    ? "nota enhanced + trascrizione"
                    : enhancedPlain
                    ? "nota enhanced"
                    : transcript.trim()
                    ? "trascrizione"
                    : "nessuno"}
                </span>
                <div className="flex-1" />
                <button
                  onClick={() => setAskOpen(false)}
                  className="press w-9 h-9 sm:w-7 sm:h-7 flex items-center justify-center rounded-lg hover:bg-surface-3/60 text-text-muted hover:text-text-primary"
                >
                  <X size={16} />
                </button>
              </div>

              <div className="flex-1 overflow-y-auto px-4 sm:px-5 py-4 space-y-3">
                {askMessages.length === 0 && !askLoading && (
                  <div className="text-[12px] text-text-faint italic leading-relaxed">
                    {askAvailable
                      ? "Fai una domanda. Le risposte saranno fondate sul contesto disponibile (nota enhanced e/o trascrizione)."
                      : "Servono almeno una nota enhanced o una trascrizione per fare domande."}
                  </div>
                )}
                {askMessages.map((m, i) => (
                  <div
                    key={i}
                    className={`max-w-[92%] rounded-2xl px-4 py-2.5 text-[13px] leading-relaxed ${
                      m.role === "user"
                        ? "ml-auto bg-accent/15 border border-accent/25 text-text-primary whitespace-pre-wrap"
                        : "mr-auto bg-surface-2/70 border border-[var(--material-border)] text-text-primary ask-md"
                    }`}
                  >
                    {m.role === "user" ? (
                      m.content
                    ) : (
                      // Assistant replies arrive as markdown (bold, lists,
                      // blockquotes…). Render them through the same
                      // mdToHtml pipeline used by the note editors so the
                      // formatting actually shows up. The wrapper class
                      // `ask-md` styles the resulting elements (see
                      // globals.css). Source is server-side AI content,
                      // not user-injected HTML, so dangerouslySetInnerHTML
                      // is acceptable here.
                      <div dangerouslySetInnerHTML={{ __html: mdToHtml(m.content) }} />
                    )}
                  </div>
                ))}
                {askLoading && (
                  <div className="mr-auto flex items-center gap-2 text-[12px] text-text-muted">
                    <Loader2 size={12} className="animate-spin-fast" />
                    Sto pensando…
                  </div>
                )}
              </div>

              <div className="border-t border-[var(--material-border)] px-3 py-2 flex items-end gap-2">
                <textarea
                  value={askInput}
                  onChange={(e) => setAskInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" && !e.shiftKey) {
                      e.preventDefault();
                      sendAsk();
                    }
                  }}
                  placeholder={askAvailable ? "Fai una domanda…" : "Servono nota enhanced o trascrizione per chiedere…"}
                  disabled={!askAvailable || askLoading}
                  rows={2}
                  className="flex-1 bg-surface-2/50 border border-[var(--material-border)] focus:border-accent/40 rounded-xl outline-none resize-none px-3 py-2 text-[13px] leading-relaxed text-text-primary placeholder:text-text-muted/60 transition-colors disabled:opacity-50"
                />
                <button
                  onClick={sendAsk}
                  disabled={!askInput.trim() || askLoading || !askAvailable}
                  className="btn-premium-accent press shrink-0 w-11 h-11 sm:w-9 sm:h-9 flex items-center justify-center rounded-xl text-white disabled:opacity-40"
                  title="Invia"
                >
                  <Send size={16} />
                </button>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* ── Error toast ── */}
      {displayError && (
        <div className="fixed bottom-20 sm:bottom-6 left-3 right-3 sm:left-1/2 sm:right-auto sm:-translate-x-1/2 material-thick border border-rec/40 rounded-2xl px-4 sm:px-5 py-3 text-xs text-rec sm:max-w-md flex items-start sm:items-center gap-3 z-[70] shadow-float animate-fade-in mb-safe">
          <span className="flex-1">{displayError}</span>
          <button
            onClick={() => { setAppError(null); clearError(); }}
            className="text-text-muted hover:text-text-secondary transition-colors shrink-0 p-1 -m-1"
          >
            <X size={14} />
          </button>
        </div>
      )}
    </div>
  );
}

// ── Refined empty state ──
function EmptyState() {
  return (
    <div className="flex flex-col items-center justify-center h-full gap-5 text-text-faint px-6 select-none animate-fade-in">
      <div className="relative">
        <div className="absolute inset-0 blur-2xl bg-accent/20 rounded-full" />
        <div className="relative w-14 h-14 rounded-2xl bg-gradient-to-br from-accent/15 to-accent/5 border border-accent/20 flex items-center justify-center">
          <Sparkles size={22} className="text-accent" strokeWidth={1.5} />
        </div>
      </div>
      <div className="text-center max-w-[280px] space-y-2">
        <p className="text-sm text-text-secondary leading-relaxed">
          Le note enhanced appariranno qui.
        </p>
        <p className="text-[12px] text-text-faint leading-relaxed">
          Scrivi qualcosa o registra audio, poi premi <span className="font-mono text-text-muted">⌘E</span>.
        </p>
      </div>
    </div>
  );
}
