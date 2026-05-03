"use client";

import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";
import Image from "@tiptap/extension-image";
import Underline from "@tiptap/extension-underline";
import Highlight from "@tiptap/extension-highlight";
import { Node, mergeAttributes } from "@tiptap/core";
import { forwardRef, useImperativeHandle, useEffect } from "react";

/* ── Resizable image — adds a `size` attribute ("small" default | "large")
   that toggles via click. Default "small" so newly-inserted images are
   compact; the user can click to expand. Persisted in markdown as
   `![alt|size](src)`. */
const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      size: {
        default: "small",
        parseHTML: (el: HTMLElement) => el.getAttribute("data-size") || "small",
        renderHTML: (attrs: Record<string, unknown>) => ({
          "data-size": (attrs.size as string) || "small",
        }),
      },
    };
  },
});

export interface TiptapHandle {
  getMarkdown: () => string;
  setHtml: (html: string) => void;
  isEmpty: () => boolean;
  insertImage: (src: string, alt?: string) => void;
  insertFile: (name: string, dataUrl: string, mime: string) => void;
}

interface Props {
  placeholder?: string;
  initialContent?: string;
  editable?: boolean;
  className?: string;
  /** Fires on every editor update (typing, paste, command, …). The page can
   *  use this to snapshot the latest content into persistent storage promptly
   *  instead of relying on a periodic timer. */
  onChange?: () => void;
}

/* ── File attachment node (PDF and other non-image files) ── */
const FileAttachment = Node.create({
  name: "fileAttachment",
  group: "block",
  atom: true,
  draggable: true,
  selectable: true,

  addAttributes() {
    return {
      name: { default: "" },
      mime: { default: "" },
      src: { default: "" },
    };
  },

  parseHTML() {
    return [{ tag: 'div[data-type="file-attachment"]' }];
  },

  renderHTML({ HTMLAttributes }) {
    const name = HTMLAttributes.name as string;
    const mime = HTMLAttributes.mime as string;
    const src = HTMLAttributes.src as string;
    const isPdf = mime === "application/pdf" || name.toLowerCase().endsWith(".pdf");
    const icon = isPdf ? "📄" : "📎";

    return [
      "div",
      mergeAttributes(HTMLAttributes, {
        "data-type": "file-attachment",
        class: "file-attachment my-3",
      }),
      [
        "a",
        {
          href: src,
          target: "_blank",
          rel: "noopener noreferrer",
          download: name,
          class: "file-chip",
        },
        ["span", { class: "file-icon" }, icon],
        ["span", { class: "file-name" }, name],
        ["span", { class: "file-mime" }, isPdf ? "PDF" : (mime.split("/")[1] || "file").toUpperCase()],
      ],
    ];
  },
});

/* ── Tiptap JSON → Markdown (best-effort, also covers images & files) ── */
function nodeText(node: Record<string, unknown>): string {
  // Hard breaks (Shift+Enter) must round-trip — without this, multi-line
  // paragraphs collapsed into a single line on reload (the user's "andare
  // a capo perso" bug). We emit a literal <br> tag in the markdown stream;
  // the page-side mdToHtml preserves it through HTML-escape (same trick as
  // <u>) and Tiptap parses it back to a hardBreak node.
  if ((node as { type?: string }).type === "hardBreak") return "<br>";
  if (typeof (node as { text?: string }).text === "string") {
    const marks = (node as { marks?: { type: string }[] }).marks || [];
    let t = (node as { text: string }).text;
    if (marks.some((m) => m.type === "bold")) t = `**${t}**`;
    if (marks.some((m) => m.type === "italic")) t = `*${t}*`;
    if (marks.some((m) => m.type === "underline")) t = `<u>${t}</u>`;
    if (marks.some((m) => m.type === "highlight")) t = `==${t}==`;
    return t;
  }
  return ((node as { content?: Record<string, unknown>[] }).content || []).map(nodeText).join("");
}

function docToMarkdown(doc: Record<string, unknown>): string {
  const lines: string[] = [];
  for (const node of (doc as { content?: Record<string, unknown>[] }).content || []) {
    const type = node.type as string;
    const attrs = (node as { attrs?: Record<string, unknown> }).attrs || {};
    if (type === "heading") {
      const level = (attrs.level as number) || 1;
      lines.push("#".repeat(level) + " " + nodeText(node));
    } else if (type === "bulletList") {
      for (const item of (node as { content?: Record<string, unknown>[] }).content || []) {
        lines.push("- " + nodeText(item));
      }
    } else if (type === "image") {
      const src = attrs.src as string;
      const alt = (attrs.alt as string) || "image";
      const size = (attrs.size as string) || "small";
      // Embed size as part of alt so it round-trips through plain markdown.
      lines.push(`![${alt}|${size}](${src})`);
    } else if (type === "fileAttachment") {
      const name = attrs.name as string;
      const src = attrs.src as string;
      lines.push(`[📎 ${name}](${src})`);
    } else if (type === "paragraph") {
      lines.push(nodeText(node));
    }
  }
  return lines.join("\n").trim();
}

/* ── File reading helper ── */
function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result as string);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(file);
  });
}

const TiptapEditor = forwardRef<TiptapHandle, Props>(
  ({ placeholder = "", initialContent, editable = true, className, onChange }, ref) => {
    const editor = useEditor({
      // Tiptap v2.10+ defaults `immediatelyRender` to `true`, which trips the
      // SSR-detection guard inside Next.js' hydration. Even though we already
      // dynamic-import this component with `ssr: false`, Tiptap still sees the
      // first React render as a server context. Setting it to `false` makes
      // the editor mount on the client only, after hydration, killing the
      // warning without changing observable behaviour.
      immediatelyRender: false,
      onUpdate: () => { onChange?.(); },
      extensions: [
        StarterKit.configure({
          heading: { levels: [1, 2, 3] },
        }),
        Underline,
        // Override default highlight keymap (Cmd+Shift+H) with Cmd+E per request.
        Highlight.extend({
          addKeyboardShortcuts() {
            return {
              "Mod-e": () => this.editor.commands.toggleHighlight(),
            };
          },
        }).configure({ multicolor: false, HTMLAttributes: { class: "hl-hermes" } }),
        ResizableImage.configure({ inline: false, allowBase64: true, HTMLAttributes: { class: "tiptap-img" } }),
        FileAttachment,
        Placeholder.configure({ placeholder }),
      ],
      content: initialContent || "",
      editable,
      editorProps: {
        attributes: {
          class: `tiptap-editor ${className || ""}`,
        },
        // Click on an image toggles its size between "large" (full width) and
        // "small" (~220px). ProseMirror passes us:
        //   - `pos` = position INSIDE/AROUND the click (not always at the node)
        //   - `nodePos` = position OF the node itself (what setNodeMarkup needs)
        // Using `pos` raised "No node at given position" when the click landed
        // on the image's wrapping paragraph offset. `nodePos` is the safe one.
        handleClickOn: (view, _pos, node, nodePos) => {
          if (node.type.name === "image") {
            const current = (node.attrs.size as string) || "large";
            const next = current === "large" ? "small" : "large";
            try {
              view.dispatch(
                view.state.tr.setNodeMarkup(nodePos, undefined, { ...node.attrs, size: next })
              );
            } catch (err) {
              console.error("Image resize failed:", err);
            }
            return true;
          }
          return false;
        },
        handlePaste: (view, event) => {
          const items = event.clipboardData?.items;
          if (!items) return false;
          for (let i = 0; i < items.length; i++) {
            const item = items[i];
            if (item.kind === "file") {
              const file = item.getAsFile();
              if (file) {
                event.preventDefault();
                handleFileInsert(file, view);
                return true;
              }
            }
          }
          return false;
        },
        handleDrop: (view, event) => {
          const files = event.dataTransfer?.files;
          if (!files || files.length === 0) return false;
          event.preventDefault();
          for (let i = 0; i < files.length; i++) {
            handleFileInsert(files[i], view);
          }
          return true;
        },
      },
    });

    // Helper that inserts a file into the editor (called from paste/drop)
    async function handleFileInsert(file: File, _view?: unknown) {
      if (!editor) return;
      try {
        const dataUrl = await readFileAsDataURL(file);
        if (file.type.startsWith("image/")) {
          editor.chain().focus().setImage({ src: dataUrl, alt: file.name }).run();
        } else {
          editor.chain().focus().insertContent({
            type: "fileAttachment",
            attrs: { name: file.name, mime: file.type, src: dataUrl },
          }).run();
        }
      } catch (e) {
        console.error("File insert failed:", e);
      }
    }

    useImperativeHandle(ref, () => ({
      getMarkdown: () => {
        if (!editor) return "";
        return docToMarkdown(editor.getJSON() as Record<string, unknown>);
      },
      setHtml: (html: string) => {
        if (!editor) return;
        editor.commands.setContent(html);
      },
      isEmpty: () => {
        if (!editor) return true;
        return editor.isEmpty;
      },
      insertImage: (src: string, alt?: string) => {
        editor?.chain().focus().setImage({ src, alt: alt || "" }).run();
      },
      insertFile: (name: string, dataUrl: string, mime: string) => {
        editor?.chain().focus().insertContent({
          type: "fileAttachment",
          attrs: { name, mime, src: dataUrl },
        }).run();
      },
    }));

    // Update content when initialContent changes (for enhanced editor)
    useEffect(() => {
      if (initialContent && editor && !editor.isDestroyed) {
        editor.commands.setContent(initialContent);
      }
    }, [initialContent, editor]);

    if (!editor) return null;

    return <EditorContent editor={editor} className="h-full" />;
  }
);

TiptapEditor.displayName = "TiptapEditor";
export default TiptapEditor;
