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
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

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
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username: username.trim(), password }),
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
          <form
            onSubmit={submit}
            className="material-thick rounded-2xl border shadow-float p-6 space-y-4"
          >
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

            {isRegister && (
              <p className="text-[12px] text-text-secondary leading-relaxed">
                Scegli uno username (3–32 caratteri, lettere/numeri/.-_) e una
                password di almeno 8 caratteri. Le tue note saranno separate
                dagli altri account.
              </p>
            )}

            <div className="space-y-2.5">
              <input
                type="text"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
                placeholder="Username"
                autoComplete="username"
                required
                minLength={isRegister ? 3 : 1}
                maxLength={32}
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
            </div>

            {error && (
              <div className="text-[12px] text-rec bg-rec/10 border border-rec/25 rounded-lg px-3 py-2">
                {error}
              </div>
            )}

            <button
              type="submit"
              disabled={loading}
              className="btn-premium-accent press w-full h-9 rounded-xl text-[13px] font-medium tracking-tight text-white disabled:opacity-50 inline-flex items-center justify-center gap-2"
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

            {isRegister && (
              <p className="text-[10.5px] text-text-faint leading-relaxed text-center">
                La password viene salvata solo come hash bcrypt (12 round). Nessuno — neanche tu — potrà recuperarla in chiaro.
              </p>
            )}
          </form>
        </div>
      </div>
    </div>
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
