"use client";

import { useEffect, useState, FormEvent } from "react";
import { useRouter } from "next/navigation";
import { Loader2, Lock, Sparkles, UserPlus } from "lucide-react";

type Mode = "loading" | "login" | "register";

export default function LoginPage() {
  const router = useRouter();
  const [mode, setMode] = useState<Mode>("loading");
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);

  // Decide whether to show register or login.
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
        setMode(d.needsRegister ? "register" : "login");
      })
      .catch(() => {
        if (!cancelled) setMode("login");
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
        // If login was attempted but no account exists, swap to register.
        if (data.needsRegister) setMode("register");
        return;
      }
      router.replace("/");
    } catch {
      setError("Errore di rete.");
    } finally {
      setLoading(false);
    }
  }

  if (mode === "loading") {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-surface-0 text-text-muted text-sm gap-2">
        <Loader2 size={14} className="animate-spin-fast" />
        Verifica sessione…
      </div>
    );
  }

  const isRegister = mode === "register";

  return (
    <div className="min-h-dvh flex items-center justify-center px-4 bg-surface-0">
      <div className="w-full max-w-sm">
        <div className="flex items-center justify-center gap-2 mb-6 text-[13px] text-text-muted">
          <span className="font-bold text-text-primary tracking-tight">nota</span>
          <span className="text-accent opacity-50">/</span>
          <span className="text-accent tracking-tight font-medium">enhance</span>
        </div>

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
              Prima volta su questa istanza. Le credenziali che inserisci ora diventeranno
              <span className="font-medium text-text-primary"> quelle ufficiali</span> — non potranno
              essere ricreate da nessun altro su questo deploy.
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
              maxLength={64}
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

          {isRegister && (
            <p className="text-[10.5px] text-text-faint leading-relaxed text-center">
              La password viene salvata solo come hash bcrypt (12 round). Nessuno — neanche tu — potrà recuperarla in chiaro.
            </p>
          )}
        </form>
      </div>
    </div>
  );
}
