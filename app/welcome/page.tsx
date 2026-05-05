"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Mic, FileDown, ArrowRight } from "lucide-react";

// Public landing page — shown to unauthenticated visitors. Authenticated
// users are redirected to "/" (the app) on mount, so a logged-in user
// hitting /welcome by mistake doesn't land on a marketing page that no
// longer applies to them.
export default function WelcomePage() {
  const router = useRouter();

  useEffect(() => {
    let cancelled = false;
    fetch("/api/auth/me", { cache: "no-store" })
      .then((r) => r.json())
      .then((d) => {
        if (cancelled) return;
        if (d.authenticated) router.replace("/");
      })
      .catch(() => {});
    return () => { cancelled = true; };
  }, [router]);

  return (
    <div className="min-h-dvh bg-surface-0 text-text-primary flex flex-col">
      {/* ── Header ── */}
      <header className="px-6 md:px-10 py-5 flex items-center justify-between">
        <div className="flex items-center gap-2 text-[14px]">
          <span className="font-bold text-text-emphasis tracking-tight">nota</span>
          <span className="text-accent opacity-50">/</span>
          <span className="text-accent tracking-tight font-medium">enhance</span>
        </div>
        <div className="flex items-center gap-2">
          <Link
            href="/login?mode=login"
            className="press h-9 px-4 rounded-lg text-[13px] font-medium tracking-tight text-text-secondary hover:text-text-primary inline-flex items-center"
          >
            Accedi
          </Link>
          <Link
            href="/login?mode=register"
            className="btn-premium-accent press h-9 px-4 rounded-lg text-[13px] font-medium tracking-tight inline-flex items-center gap-1.5"
          >
            Inizia
          </Link>
        </div>
      </header>

      {/* ── Hero ── */}
      <main className="flex-1 px-6 md:px-10 pt-12 md:pt-24 pb-16">
        <section className="max-w-3xl mx-auto text-center">
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-text-emphasis leading-[1.05] mb-6">
            Le note di lezione,{" "}
            <span className="text-accent">sistemate da sole</span>.
          </h1>
          <p className="text-[15px] md:text-[17px] text-text-secondary leading-relaxed max-w-2xl mx-auto mb-10">
            Registri il prof, scrivi due cose al volo, a fine giornata trovi una
            pagina che si rilegge. Pronta in PDF la settimana prima dell&apos;esame —
            non quella sera che la cerchi.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/login?mode=register"
              className="btn-premium-accent press h-11 px-6 rounded-xl text-[14px] font-medium tracking-tight inline-flex items-center justify-center gap-2"
            >
              Inizia ora
              <ArrowRight size={15} />
            </Link>
            <Link
              href="/login?mode=login"
              className="press h-11 px-6 rounded-xl text-[14px] font-medium tracking-tight border border-[var(--material-border-strong)] bg-surface-2/60 hover:bg-surface-3/70 text-text-primary inline-flex items-center justify-center"
            >
              Ho già un account
            </Link>
          </div>
        </section>

        {/* ── Feature grid ── */}
        <section className="mt-20 md:mt-32 max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-4">
          <Feature
            icon={<Mic size={16} className="text-accent" />}
            title="L'audio della lezione, in testo"
            body="Importi la registrazione, anche di un'ora intera. Esce trascritta direttamente nelle note. Niente da copiare a mano."
          />
          <Feature
            icon={<Sparkles size={16} className="text-accent" />}
            title="Gli appunti grezzi, sistemati"
            body="Quello che hai buttato giù in fretta diventa una pagina che si capisce. Lo stile lo decidi tu, non un template uguale per tutti."
          />
          <Feature
            icon={<FileDown size={16} className="text-accent" />}
            title="Sincronizzato, esportabile"
            body="Aggiungi una riga in metro, finisci sul portatile a casa. Quando ti serve ripassare offline, esporti in PDF."
          />
        </section>

        {/* ── Closing line ──
            One short paragraph instead of the old "Privacy by design" buzzword
            block. Says the only privacy thing that actually matters to a new
            visitor (your stuff isn't mixed with someone else's) and gets out
            of the way. */}
        <section className="mt-20 md:mt-28 max-w-2xl mx-auto text-center">
          <p className="text-[13px] text-text-muted leading-relaxed">
            Ogni account ha il suo archivio. Le note non si mescolano fra
            utenti. Le password sono solo hash — nessuno le legge in chiaro.
          </p>
        </section>
      </main>

      {/* ── Footer ── */}
      <footer className="px-6 md:px-10 py-6 border-t border-[var(--material-border)]">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3 text-[11px] text-text-faint font-mono">
          <span>© nota/enhance</span>
          <div className="flex items-center gap-4">
            <Link href="/login?mode=login" className="hover:text-text-secondary">Accedi</Link>
            <Link href="/login?mode=register" className="hover:text-text-secondary">Registrati</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Feature({
  icon, title, body,
}: { icon: React.ReactNode; title: string; body: string }) {
  return (
    <div className="material-regular border rounded-2xl p-5">
      <div className="w-8 h-8 rounded-xl bg-accent/15 border border-accent/25 flex items-center justify-center mb-3">
        {icon}
      </div>
      <h3 className="text-[13px] font-semibold text-text-emphasis tracking-tight mb-1.5">
        {title}
      </h3>
      <p className="text-[12.5px] text-text-secondary leading-relaxed">
        {body}
      </p>
    </div>
  );
}
