// Markdown helpers shared between the editors, the AI bubbles and the
// PDF export. Lives in lib/ rather than app/ because it has no React
// or Next dependencies — pure string transforms — and can be imported
// from server routes too if we ever need it there.

/** HTML-escape user-controlled text before interpolation. Covers
 *  `& < > " '` so the result is also safe inside double-quoted
 *  attribute values. */
export function htmlEscape(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/* ── Markdown → HTML (tolerant of inline tags emitted by Tiptap serializer) ──
   The Tiptap → markdown serializer emits raw <u>...</u> for underline,
   <br> for hardBreak, and ==..== for highlight (Tiptap doesn't have a
   canonical markdown form for these). The reverse path therefore has to:
     1. preserve those inline tags through HTML escaping
     2. re-process bold (**), italic (*), highlight (==), and the
        inline-tag placeholders into proper HTML
   Order matters: bold first (so its `**` aren't eaten by the italic pass),
   then italic, then highlight, then escape-restore.
*/
export function mdToHtml(md: string): string {
  const lines = md.split("\n");
  let html = "";
  let inUl = false;
  const esc = htmlEscape;

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
    //    Both `src` and `name` get escape-quoted so a malicious markdown
    //    URL containing `"` can't break out of the attribute and inject
    //    arbitrary HTML.
    const placeholders: string[] = [];
    t = t.replace(IMG_RE, (_m, alt: string, src: string) => {
      const parts = alt.split("|");
      const realAlt = parts[0] || "";
      // Default small unless the markdown explicitly opted into "large".
      const size = parts[1] === "large" ? "large" : "small";
      placeholders.push(`<img class="tiptap-img" data-size="${size}" src="${esc(src)}" alt="${esc(realAlt)}" />`);
      return `\x00P${placeholders.length - 1}\x00`;
    });
    t = t.replace(FILE_RE, (_m, name: string, src: string) => {
      placeholders.push(`<div data-type="file-attachment" name="${esc(name)}" src="${esc(src)}"></div>`);
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
