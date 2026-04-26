# nota / enhance

Single-user note-taking app with AI enhancement, audio transcription, and Ask AI over your enhanced notes.

## Stack

- **Next.js 15** — App Router + Edge middleware
- **Tiptap** — Rich text editor (bold, underline, highlight, headings, images, file chips)
- **OpenRouter (DeepSeek V4 Flash)** — AI Enhance + Ask AI
- **Groq (Whisper)** — Audio transcription on stop / on import
- **Tailwind CSS 3** — Styling, custom Hermès palette + Apple HIG materials
- **IndexedDB** — Local note storage (browser-side, per device)
- **Vercel KV** — Credential storage in production
- **bcryptjs + jose** — Password hashing + signed-cookie sessions

## Local development

```bash
# 1. Dependencies
npm install

# 2. Environment
cp .env.example .env.local
# Edit .env.local — at minimum:
#   OPENROUTER_API_KEY=sk-or-v1-...
#   GROQ_API_KEY=gsk_...
#   AUTH_SECRET=$(openssl rand -base64 48)

# 3. Run
npm run dev
```

Apri [http://localhost:3000](http://localhost:3000). Al primo accesso vedrai la pagina di
**registrazione iniziale**: scegli username + password (min 8 caratteri). Quelle credenziali
vengono salvate in `.credentials.json` (gitignored) come hash bcrypt e diventano le uniche
valide per questa istanza.

## Production deploy (Vercel)

### 1. Crea il progetto

```bash
npm i -g vercel       # se non già installato
vercel link           # collega la cartella a un progetto Vercel
```

### 2. Crea uno store KV

Dashboard Vercel → progetto → tab **Storage** → **Create Database** → **KV**.
Vercel popola automaticamente nel progetto le env vars:

- `KV_REST_API_URL`
- `KV_REST_API_TOKEN`
- (altre, non necessarie a noi)

L'app le rileva via `kvConfigured()` in `lib/credential-store.ts` e usa KV invece del file
locale per le credenziali.

### 3. Imposta le altre env vars

In **Project Settings → Environment Variables** aggiungi (Production + Preview + Dev):

| Variabile               | Valore                                              |
|-------------------------|------------------------------------------------------|
| `OPENROUTER_API_KEY`    | la tua chiave OpenRouter                             |
| `GROQ_API_KEY`          | la tua chiave Groq                                   |
| `AUTH_SECRET`           | output di `openssl rand -base64 48` (≥ 16 caratteri) |
| `OPENROUTER_MODEL`      | (opz.) override modello, default `deepseek/deepseek-v4-flash` |

> **Importante.** Senza `AUTH_SECRET` configurata in production l'app rifiuta di gestire
> sessioni e si blocca al login. È una scelta deliberata per evitare deploy "in chiaro".

### 4. Deploy

```bash
vercel --prod
```

Apri la URL fornita e **registra immediatamente le credenziali iniziali**. Da quel momento
in poi nessun altro può creare un account su quell'istanza: l'endpoint `/api/auth/register`
risponde 409 finché esiste già una credenziale in KV.

### 5. (opzionale) Cambio password

Non c'è una UI di "change password" — è un'app single-user, semplice. Per rotare la
credenziale: vai nello store KV su Vercel, elimina la chiave `nota-enhance:admin-credential`,
poi rilancia `/login` e re-registrati. Lo stesso vale in locale: cancella `.credentials.json`.

## Architettura auth

```
Browser
  │
  ├── GET /            ──► middleware.ts ──► verifySessionToken (jose, edge)
  │                                          │
  │                          token ok? ───► render app
  │                          token bad? ──► 302 /login
  │
  ├── POST /api/auth/register ──► nodejs runtime ──► bcrypt.hash(12) ──► KV/file
  ├── POST /api/auth/login    ──► nodejs runtime ──► bcrypt.compare    ──► JWT cookie
  ├── POST /api/auth/logout   ──► clears cookie
  └── GET  /api/auth/me       ──► current session info
```

- **Cookie**: HttpOnly, Secure (in prod), SameSite=Lax, 30 giorni
- **JWT**: HS256 firmato con `AUTH_SECRET`
- **Hash**: bcrypt round 12 (~150ms per chiamata, ok su Vercel serverless)
- **Rate limit**: 8 tentativi/​minuto per IP sul login (in-memory, best-effort)

## Note features

- Salvataggio istantaneo (IndexedDB + multipli trigger: editor `onUpdate`, state changes,
  autosave 1 s, `pagehide`/​`visibilitychange:hidden`)
- Note pinnate, split ratio per-nota, conversazioni Ask AI persistite per nota
- Export PDF via `window.print()` (open print dialog → salva come PDF)
- Immagini con toggle small/large al click
- Default UI a 115% zoom (come ⌘+ in Safari)

## Comandi rapidi

| Shortcut          | Azione                                     |
|-------------------|--------------------------------------------|
| ⌘K                | Command palette                            |
| ⌘\\               | Toggle sidebar                             |
| ⌘N                | Nuova nota                                 |
| ⌘⇧E               | Enhance                                    |
| ⌘B / ⌘I / ⌘U / ⌘E | Bold / Italic / Underline / Highlight (in editor) |

(Shortcut globali rimappabili da Settings → Scorciatoie.)
