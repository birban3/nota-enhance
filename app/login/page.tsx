"use client";

import { useEffect, useState, FormEvent, Suspense } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import Link from "next/link";
import { Loader2, Lock, Sparkles, UserPlus, ArrowLeft } from "lucide-react";

type Mode = "login" | "register";

function LoginInner() {
  const router = useRouter();
  const search = useSearchParams();
  // Mode is driven by the ?mode= query param so the landing page can deep-link
  // straight to either form. Default to login (the more common case once an
  // account exists). Users can swap modes from the bottom toggle.
  const initialMode: Mode = search.get("mode") === "register" ? "register" : "login";
  const [mode, setMode] = useState<Mode>(initialMode);
  const [checkingSession, setCheckingSession] = useState(true);
  const [firstName, setFirstName] = useState("");
  const [lastName, setLastName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // OAuth callback errors are passed back through ?oauth_error=… so we
  // surface them in the same error slot the form uses.
  useEffect(() => {
    const oauthErr = search.get("oauth_error");
    if (oauthErr) setError(oauthErr);
  }, [search]);

  // Bounce already-authenticated visitors straight to the app.
  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.authenticated) {
          router.replace("/");
          return;
        }
        setCheckingSession(false);
      })
      .catch(() => {
        if (!cancelled) setCheckingSession(false);
      });
    return () => { cancelled = true; };
  }, [router]);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (mode === "register" && password !== confirm) {
      setError("Le due password non coincidono.");
      return;
    }
    setLoading(true);
    try {
      const url = mode === "register" ? "/api/auth/register" : "/api/auth/login";
      const body: Record<string, string> = {
        email: email.trim(),
        password,
      };
      if (mode === "register") {
        body.firstName = firstName.trim();
        body.lastName = lastName.trim();
      }
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const data = await res.json();
      if (!res.ok) {
        setError(data.error || "Errore.");
        return;
      }
      router.replace("/");
    } catch {
      setError("Errore di rete.");
    } finally {
      setLoading(false);
    }
  }

  function swapMode(next: Mode) {
    setMode(next);
    setError(null);
    setConfirm("");
  }

  if (checkingSession) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-surface-0 text-text-muted text-sm gap-2">
        <Loader2 size={14} className="animate-spin-fast" />
        Verifica sessione…
      </div>
    );
  }

  const isRegister = mode === "register";

  return (
    <div className="min-h-dvh flex flex-col bg-surface-0">
      <header className="px-6 md:px-10 py-5 flex items-center justify-between">
        <Link
          href="/welcome"
          className="press inline-flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text-secondary"
        >
          <ArrowLeft size={13} /> Indietro
        </Link>
        <div className="flex items-center gap-2 text-[13px] text-text-muted">
          <span className="font-bold text-text-primary tracking-tight">nota</span>
          <span className="text-accent opacity-50">/</span>
          <span className="text-accent tracking-tight font-medium">enhance</span>
        </div>
      </header>

      <div className="flex-1 flex items-center justify-center px-4 pb-10">
        <div className="w-full max-w-sm">
          <div className="material-thick rounded-2xl border shadow-float p-6 space-y-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center">
                {isRegister ? (
                  <UserPlus size={14} className="text-accent" />
                ) : (
                  <Lock size={14} className="text-accent" />
                )}
              </div>
              <h1 className="text-[15px] font-semibold tracking-tight text-text-emphasis">
                {isRegister ? "Crea il tuo account" : "Accedi"}
              </h1>
            </div>

            {/* ── Continue with Google ──
                Placed above the password form so the path of least friction
                is the first thing the user sees. The form below is the
                fallback for users who don't want to use Google. */}
            <a
              href="/api/auth/google"
              className="press w-full h-10 rounded-xl border border-[var(--material-border-strong)] bg-surface-2/60 hover:bg-surface-3/70 text-text-primary text-[13px] font-medium tracking-tight inline-flex items-center justify-center gap-2.5"
            >
              <GoogleG />
              Continua con Google
            </a>

            <div className="flex items-center gap-3 text-[10.5px] text-text-faint font-mono uppercase tracking-[0.18em]">
              <span className="flex-1 h-px bg-[var(--material-border)]" />
              oppure
              <span className="flex-1 h-px bg-[var(--material-border)]" />
            </div>

            <form onSubmit={submit} className="space-y-2.5">
              {isRegister && (
                <div className="grid grid-cols-2 gap-2.5">
                  <input
                    type="text"
                    value={firstName}
                    onChange={(e) => setFirstName(e.target.value)}
                    placeholder="Nome"
                    autoComplete="given-name"
                    required
                    minLength={1}
                    maxLength={50}
                    className="w-full bg-surface-2/60 border border-[var(--material-border)] focus:border-accent/40 rounded-xl outline-none px-3 py-2.5 text-[13px] text-text-primary placeholder:text-text-muted/60 transition-colors"
                  />
                  <input
                    type="text"
                    value={lastName}
                    onChange={(e) => setLastName(e.target.value)}
                    placeholder="Cognome"
                    autoComplete="family-name"
                    required
                    minLength={1}
                    maxLength={50}
                    className="w-full bg-surface-2/60 border border-[var(--material-border)] focus:border-accent/40 rounded-xl outline-none px-3 py-2.5 text-[13px] text-text-primary placeholder:text-text-muted/60 transition-colors"
                  />
                </div>
              )}
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder="Email"
                autoComplete="email"
                required
                maxLength={200}
                className="w-full bg-surface-2/60 border border-[var(--material-border)] focus:border-accent/40 rounded-xl outline-none px-3 py-2.5 text-[13px] text-text-primary placeholder:text-text-muted/60 transition-colors"
              />
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                placeholder={isRegister ? "Password (min 8)" : "Password"}
                autoComplete={isRegister ? "new-password" : "current-password"}
                required
                minLength={isRegister ? 8 : 1}
                maxLength={200}
                className="w-full bg-surface-2/60 border border-[var(--material-border)] focus:border-accent/40 rounded-xl outline-none px-3 py-2.5 text-[13px] text-text-primary placeholder:text-text-muted/60 transition-colors"
              />
              {isRegister && (
                <input
                  type="password"
                  value={confirm}
                  onChange={(e) => setConfirm(e.target.value)}
                  placeholder="Conferma password"
                  autoComplete="new-password"
                  required
                  minLength={8}
                  maxLength={200}
                  className="w-full bg-surface-2/60 border border-[var(--material-border)] focus:border-accent/40 rounded-xl outline-none px-3 py-2.5 text-[13px] text-text-primary placeholder:text-text-muted/60 transition-colors"
                />
              )}

              {error && (
                <div className="text-[12px] text-rec bg-rec/10 border border-rec/25 rounded-lg px-3 py-2">
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={loading}
                className="btn-premium-accent press w-full h-9 rounded-xl text-[13px] font-medium tracking-tight text-white disabled:opacity-50 inline-flex items-center justify-center gap-2 mt-1"
              >
                {loading ? (
                  <Loader2 size={14} className="animate-spin-fast" />
                ) : isRegister ? (
                  <>
                    <Sparkles size={13} /> Crea account
                  </>
                ) : (
                  "Accedi"
                )}
              </button>
            </form>

            <div className="text-[12px] text-text-muted text-center">
              {isRegister ? (
                <>
                  Hai già un account?{" "}
                  <button
                    type="button"
                    onClick={() => swapMode("login")}
                    className="text-accent hover:underline"
                  >
                    Accedi
                  </button>
                </>
              ) : (
                <>
                  Non hai un account?{" "}
                  <button
                    type="button"
                    onClick={() => swapMode("register")}
                    className="text-accent hover:underline"
                  >
                    Registrati
                  </button>
                </>
              )}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

// Multi-color Google "G" mark, sized to sit next to a 13px label. We
// inline the SVG instead of pulling in an icon dependency so the brand
// glyph renders correctly even with strict CSP / no external requests.
function GoogleG() {
  return (
    <svg width="16" height="16" viewBox="0 0 48 48" aria-hidden="true">
      <path fill="#FFC107" d="M43.611 20.083H42V20H24v8h11.303c-1.649 4.657-6.08 8-11.303 8-6.627 0-12-5.373-12-12s5.373-12 12-12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 12.955 4 4 12.955 4 24s8.955 20 20 20 20-8.955 20-20c0-1.341-.138-2.65-.389-3.917z"/>
      <path fill="#FF3D00" d="m6.306 14.691 6.571 4.819C14.655 15.108 18.961 12 24 12c3.059 0 5.842 1.154 7.961 3.039l5.657-5.657C34.046 6.053 29.268 4 24 4 16.318 4 9.656 8.337 6.306 14.691z"/>
      <path fill="#4CAF50" d="M24 44c5.166 0 9.86-1.977 13.409-5.192l-6.19-5.238C29.211 35.091 26.715 36 24 36c-5.202 0-9.619-3.317-11.283-7.946l-6.522 5.025C9.505 39.556 16.227 44 24 44z"/>
      <path fill="#1976D2" d="M43.611 20.083H42V20H24v8h11.303a12.04 12.04 0 0 1-4.087 5.571l.003-.002 6.19 5.238C36.971 39.205 44 34 44 24c0-1.341-.138-2.65-.389-3.917z"/>
    </svg>
  );
}

// useSearchParams() must live inside a Suspense boundary in Next 15 app router.
// The fallback matches the inner page's session-check skeleton so there's no
// visual flash between the two states.
export default function LoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-dvh flex items-center justify-center bg-surface-0 text-text-muted text-sm gap-2">
        <Loader2 size={14} className="animate-spin-fast" />
        Caricamento…
      </div>
    }>
      <LoginInner />
    </Suspense>
  );
}
