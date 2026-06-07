"use client";

import { useEffect, useState, useCallback, Suspense } from "react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import {
  ArrowLeft, Loader2, CreditCard, AlertTriangle, Check, X as XIcon,
  ChevronRight, LogOut, BookOpenCheck,
} from "lucide-react";
import { BrandLoader, useBrandLoaderGate } from "@/components/BrandLoader";

interface Plan {
  id: string;
  displayName: string;
  monthlyCredits: number;
  hasStripePrice: boolean;
  position: number;
}
interface Profile {
  plan: string;
  credits: number;
  monthlyCredits: number;
  creditsPeriodStart: number | null;
  subscriptionStatus: string | null;
  subscriptionPeriodEnd: number | null;
  hasStripeCustomer: boolean;
}
interface User {
  username: string;
  email: string | null;
  firstName: string | null;
  lastName: string | null;
  hasPassword: boolean;
  hasGoogle: boolean;
}
interface CreditTx {
  id: number;
  operation: string;
  amount: number;
  balanceAfter: number;
  metadata: Record<string, unknown>;
  createdAt: number;
}
interface AccountData {
  user: User;
  profile: Profile | null;
  plans: Plan[];
  transactions: CreditTx[];
}

// Human-readable label for each operation kind, used by the transactions
// table. Falls back to the raw string when an op isn't mapped so a new
// operation surfaces visibly instead of as a blank.
const OP_LABEL: Record<string, string> = {
  enhance: "Enhance AI",
  ask: "Ask AI",
  transcribe: "Trascrizione",
  enhance_refund: "Enhance (rimborso)",
  ask_refund: "Ask (rimborso)",
  transcribe_refund: "Trascrizione (rimborso)",
  welcome: "Crediti iniziali",
  monthly_init: "Avvio crediti",
  monthly_reset: "Ricarica mensile",
  subscription_renewal: "Rinnovo abbonamento",
  subscription_canceled: "Abbonamento disdetto",
  subscription_payment_failed: "Pagamento fallito",
  subscription_lapsed: "Abbonamento scaduto",
};

function fmtDate(ms: number): string {
  return new Date(ms).toLocaleString("it-IT", {
    day: "2-digit", month: "short", year: "numeric",
    hour: "2-digit", minute: "2-digit",
  });
}

function fmtShortDate(ms: number): string {
  return new Date(ms).toLocaleDateString("it-IT", {
    day: "2-digit", month: "short", year: "numeric",
  });
}

// Next 15's app router requires anything using useSearchParams() to live
// inside a Suspense boundary or the build fails (it can't statically
// prerender a page that reads URL params client-side). The inner component
// holds the actual page logic.
export default function AccountPage() {
  return (
    <Suspense fallback={<BrandLoader />}>
      <AccountInner />
    </Suspense>
  );
}

function AccountInner() {
  const router = useRouter();
  const search = useSearchParams();
  const [data, setData] = useState<AccountData | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [pending, setPending] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setError(null);
    try {
      const res = await fetch("/api/account", { cache: "no-store" });
      if (res.status === 401) {
        router.replace("/welcome");
        return;
      }
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error || "Errore di caricamento.");
        return;
      }
      const json = (await res.json()) as AccountData;
      setData(json);
    } catch {
      setError("Errore di rete.");
    } finally {
      setLoading(false);
    }
  }, [router]);

  useEffect(() => { void refresh(); }, [refresh]);

  // Hold the splash until the typewriter finishes even if the account data
  // loads first. Must be called unconditionally with the other hooks.
  const showLoader = useBrandLoaderGate(loading);

  // Show Stripe checkout success/cancel as a transient toast.
  useEffect(() => {
    const c = search.get("checkout");
    if (c === "success") {
      setToast("Abbonamento attivato. I crediti possono richiedere qualche secondo per aggiornarsi.");
    } else if (c === "cancel") {
      setToast("Checkout annullato.");
    }
    if (c) {
      const t = setTimeout(() => setToast(null), 6000);
      // Strip the param from the URL so a reload doesn't re-trigger the toast.
      router.replace("/account");
      return () => clearTimeout(t);
    }
  }, [search, router]);

  async function startCheckout(planId: string) {
    setPending(planId);
    try {
      const res = await fetch("/api/billing/checkout", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ planId }),
      });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error || "Errore checkout.");
        return;
      }
      if (body.url) window.location.href = body.url;
    } catch {
      setError("Errore di rete.");
    } finally {
      setPending(null);
    }
  }

  async function openPortal() {
    setPending("portal");
    try {
      const res = await fetch("/api/billing/portal", { method: "POST" });
      const body = await res.json();
      if (!res.ok) {
        setError(body?.error || "Errore portal.");
        return;
      }
      if (body.url) window.location.href = body.url;
    } catch {
      setError("Errore di rete.");
    } finally {
      setPending(null);
    }
  }

  async function replayTour() {
    setPending("tour");
    try {
      // Server: clear the onboarded_at stamp so the next /api/auth/me sees
      // it as null and the app reopens the tour on next mount.
      await fetch("/api/account/onboarding?action=reset", { method: "POST" });
      // Local: drop the localStorage breadcrumb so the device-scoped
      // fallback (used when PG isn't configured) also doesn't suppress it.
      try {
        if (data?.user.username) {
          localStorage.removeItem(`nota-onboarded:${data.user.username}`);
        }
      } catch {}
      // Go straight to the app so the user sees the tour immediately.
      window.location.href = "/";
    } catch {
      setError("Errore di rete.");
      setPending(null);
    }
  }

  async function doDelete() {
    setPending("delete");
    try {
      const res = await fetch("/api/account/delete", { method: "POST" });
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setError(body?.error || "Errore cancellazione.");
        return;
      }
      window.location.href = "/welcome";
    } catch {
      setError("Errore di rete.");
    } finally {
      setPending(null);
    }
  }

  async function logout() {
    setPending("logout");
    try {
      await fetch("/api/auth/logout", { method: "POST" });
    } catch {}
    window.location.href = "/login";
  }

  if (showLoader) {
    return <BrandLoader />;
  }

  if (!data) {
    return (
      <div className="min-h-dvh flex items-center justify-center bg-surface-0 text-text-muted px-6 text-sm">
        {error ?? "Impossibile caricare l'account."}
      </div>
    );
  }

  const { user, profile, plans, transactions } = data;
  const billingActive = !!profile;
  const fullName = [user.firstName, user.lastName].filter(Boolean).join(" ").trim();

  return (
    <div className="min-h-dvh bg-surface-0 text-text-primary flex flex-col">
      {/* ── Header ── */}
      <header className="px-6 md:px-10 py-5 flex items-center justify-between">
        <Link
          href="/"
          className="press inline-flex items-center gap-1.5 text-[12px] text-text-muted hover:text-text-secondary"
        >
          <ArrowLeft size={13} /> Torna all&apos;app
        </Link>
        <div className="flex items-center gap-2 text-[13px] text-text-muted">
          <span className="font-bold text-text-primary tracking-tight">nota</span>
          <span className="text-accent opacity-50">/</span>
          <span className="text-accent tracking-tight font-medium">enhance</span>
        </div>
      </header>

      <main className="flex-1 px-6 md:px-10 pb-16">
        <div className="max-w-3xl mx-auto space-y-8">
          <h1 className="text-2xl md:text-3xl font-semibold tracking-tight text-text-emphasis mt-4">
            Account
          </h1>

          {toast && (
            <div className="material-regular border rounded-xl px-4 py-3 flex items-start gap-3 text-[13px] text-text-primary">
              <Check size={16} className="text-accent shrink-0 mt-0.5" />
              <span className="flex-1">{toast}</span>
              <button onClick={() => setToast(null)} className="press text-text-muted hover:text-text-primary">
                <XIcon size={14} />
              </button>
            </div>
          )}
          {error && (
            <div className="bg-rec/10 border border-rec/30 text-rec rounded-xl px-4 py-3 text-[13px]">
              {error}
            </div>
          )}

          {/* ── Profilo ── */}
          <section className="material-regular border rounded-2xl p-5 md:p-6">
            <h2 className="text-[12px] font-semibold text-text-muted uppercase tracking-[0.14em] mb-4">
              Profilo
            </h2>
            <div className="space-y-3">
              <Row label="Nome" value={fullName || "—"} />
              <Row label="Email" value={user.email ?? user.username} />
              <Row
                label="Autenticazione"
                value={
                  [
                    user.hasPassword ? "password" : null,
                    user.hasGoogle ? "Google" : null,
                  ].filter(Boolean).join(" · ") || "—"
                }
              />
            </div>
          </section>

          {/* ── Piano + crediti ── */}
          {billingActive ? (
            <section className="material-regular border rounded-2xl p-5 md:p-6">
              <h2 className="text-[12px] font-semibold text-text-muted uppercase tracking-[0.14em] mb-4">
                Piano corrente
              </h2>
              <div className="flex items-center justify-between flex-wrap gap-4">
                <div>
                  <div className="text-[20px] font-semibold text-text-emphasis tracking-tight capitalize">
                    {profile.plan}
                  </div>
                  {profile.subscriptionStatus && (
                    <div className="text-[11px] text-text-muted font-mono mt-0.5">
                      {profile.subscriptionStatus}
                      {profile.subscriptionPeriodEnd
                        ? ` · rinnovo ${fmtShortDate(profile.subscriptionPeriodEnd)}`
                        : ""}
                    </div>
                  )}
                </div>
                <div className="text-right">
                  <div className="text-[24px] font-semibold text-text-emphasis tabular-nums">
                    {profile.credits}
                    {profile.monthlyCredits > 0 && (
                      <span className="text-text-faint text-[16px]"> / {profile.monthlyCredits}</span>
                    )}
                  </div>
                  <div className="text-[11px] text-text-muted">crediti residui</div>
                </div>
              </div>

              {/* Upgrade / manage buttons */}
              <div className="flex flex-wrap gap-2 mt-6">
                {plans
                  .filter((p) => p.id !== profile.plan)
                  .map((p) => (
                    <button
                      key={p.id}
                      onClick={() => startCheckout(p.id)}
                      disabled={!p.hasStripePrice || pending !== null}
                      title={
                        p.hasStripePrice
                          ? `Passa a ${p.displayName}`
                          : "Stripe price id non ancora configurato per questo piano"
                      }
                      className="press inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-accent/10 hover:bg-accent/15 border border-accent/30 text-accent text-[13px] font-medium disabled:opacity-40 disabled:cursor-not-allowed"
                    >
                      {pending === p.id ? (
                        <Loader2 size={13} className="animate-spin-fast" />
                      ) : (
                        <CreditCard size={13} />
                      )}
                      Passa a {p.displayName}
                      {p.monthlyCredits > 0 && (
                        <span className="text-accent/70 font-mono">
                          · {p.monthlyCredits} cr/mese
                        </span>
                      )}
                    </button>
                  ))}
                {profile.hasStripeCustomer && (
                  <button
                    onClick={openPortal}
                    disabled={pending !== null}
                    className="press inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-surface-2/60 hover:bg-surface-3/70 border border-[var(--material-border)] text-text-primary text-[13px] font-medium disabled:opacity-40"
                  >
                    {pending === "portal" ? (
                      <Loader2 size={13} className="animate-spin-fast" />
                    ) : (
                      <ChevronRight size={13} />
                    )}
                    Gestisci abbonamento
                  </button>
                )}
              </div>
            </section>
          ) : (
            <section className="material-regular border rounded-2xl p-5 md:p-6 text-[13px] text-text-muted">
              I piani e i crediti non sono ancora attivi su questa istanza.
            </section>
          )}

          {/* ── Cronologia crediti ── */}
          {billingActive && (
            <section className="material-regular border rounded-2xl p-5 md:p-6">
              <h2 className="text-[12px] font-semibold text-text-muted uppercase tracking-[0.14em] mb-4">
                Cronologia ultimi crediti
              </h2>
              {transactions.length === 0 ? (
                <div className="text-[13px] text-text-muted">
                  Nessuna operazione registrata.
                </div>
              ) : (
                <ul className="divide-y divide-[var(--material-border)]">
                  {transactions.map((t) => (
                    <li key={t.id} className="py-3 flex items-center gap-3">
                      <div className="flex-1 min-w-0">
                        <div className="text-[13px] text-text-primary truncate">
                          {OP_LABEL[t.operation] ?? t.operation}
                        </div>
                        <div className="text-[11px] text-text-faint font-mono">
                          {fmtDate(t.createdAt)}
                        </div>
                      </div>
                      <div
                        className={`text-[13px] font-mono tabular-nums ${
                          t.amount > 0 ? "text-accent" : t.amount < 0 ? "text-text-secondary" : "text-text-faint"
                        }`}
                      >
                        {t.amount > 0 ? `+${t.amount}` : t.amount}
                      </div>
                      <div className="text-[11px] text-text-faint font-mono tabular-nums w-10 text-right">
                        = {t.balanceAfter}
                      </div>
                    </li>
                  ))}
                </ul>
              )}
            </section>
          )}

          {/* ── Logout + tour replay ── */}
          <section className="flex flex-wrap gap-2">
            <button
              onClick={replayTour}
              disabled={pending !== null}
              title="Rifai il tour interattivo al prossimo accesso all'app"
              className="press inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-surface-2/60 hover:bg-surface-3/70 border border-[var(--material-border)] text-text-secondary hover:text-text-primary text-[13px] font-medium"
            >
              {pending === "tour" ? (
                <Loader2 size={13} className="animate-spin-fast" />
              ) : (
                <BookOpenCheck size={13} />
              )}
              Rifai il tour
            </button>
            <button
              onClick={logout}
              disabled={pending !== null}
              className="press inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-surface-2/60 hover:bg-surface-3/70 border border-[var(--material-border)] text-text-secondary hover:text-text-primary text-[13px] font-medium"
            >
              {pending === "logout" ? (
                <Loader2 size={13} className="animate-spin-fast" />
              ) : (
                <LogOut size={13} />
              )}
              Esci
            </button>
          </section>

          {/* ── Danger zone ── */}
          <section className="border border-rec/30 rounded-2xl p-5 md:p-6">
            <h2 className="text-[12px] font-semibold text-rec uppercase tracking-[0.14em] mb-2 flex items-center gap-1.5">
              <AlertTriangle size={13} />
              Zona pericolosa
            </h2>
            <p className="text-[13px] text-text-secondary leading-relaxed mb-4">
              Cancellare l&apos;account elimina definitivamente le tue note, la
              cronologia crediti e {profile?.hasStripeCustomer ? "annulla l'abbonamento " : ""}
              non può essere annullato. Le note non sono recuperabili.
            </p>
            {confirmDelete ? (
              <div className="flex items-center gap-2">
                <button
                  onClick={doDelete}
                  disabled={pending !== null}
                  className="press inline-flex items-center gap-1.5 h-9 px-4 rounded-xl bg-rec hover:bg-rec/90 text-white text-[13px] font-medium disabled:opacity-50"
                >
                  {pending === "delete" ? <Loader2 size={13} className="animate-spin-fast" /> : <AlertTriangle size={13} />}
                  Confermo, cancella
                </button>
                <button
                  onClick={() => setConfirmDelete(false)}
                  className="press h-9 px-4 rounded-xl text-text-muted hover:text-text-primary text-[13px]"
                >
                  Annulla
                </button>
              </div>
            ) : (
              <button
                onClick={() => setConfirmDelete(true)}
                className="press inline-flex items-center gap-1.5 h-9 px-4 rounded-xl border border-rec/40 text-rec hover:bg-rec/10 text-[13px] font-medium"
              >
                Cancella account
              </button>
            )}
          </section>
        </div>
      </main>
    </div>
  );
}

function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between gap-4">
      <span className="text-[12px] text-text-muted uppercase tracking-[0.08em]">{label}</span>
      <span className="text-[13.5px] text-text-primary text-right break-all">{value}</span>
    </div>
  );
}
