"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { Sparkles, Mic, FileDown, MessageCircle, ArrowRight } from "lucide-react";

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
            <Sparkles size={13} />
            Registrati
          </Link>
        </div>
      </header>

      {/* ── Hero ── */}
      <main className="flex-1 px-6 md:px-10 pt-10 md:pt-20 pb-16">
        <section className="max-w-3xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 h-7 px-3 rounded-full bg-accent/10 border border-accent/25 text-accent text-[11px] font-mono uppercase tracking-[0.18em] mb-8">
            <span className="w-1.5 h-1.5 rounded-full bg-accent" />
            Public beta
          </div>
          <h1 className="text-4xl md:text-6xl font-bold tracking-tight text-text-emphasis leading-[1.05] mb-6">
            Note che si trasformano,{" "}
            <span className="text-accent">non solo annotate</span>.
          </h1>
          <p className="text-[15px] md:text-[17px] text-text-secondary leading-relaxed max-w-2xl mx-auto mb-10">
            Scrivi, registra, importa audio, e lascia che l&apos;AI riformatti i tuoi
            appunti come una pagina ben curata. Sincronizzato fra tutti i tuoi dispositivi,
            esportabile in PDF, e tutto privato — solo tuo.
          </p>
          <div className="flex flex-col sm:flex-row gap-3 justify-center">
            <Link
              href="/login?mode=register"
              className="btn-premium-accent press h-11 px-6 rounded-xl text-[14px] font-medium tracking-tight inline-flex items-center justify-center gap-2"
            >
              Crea il tuo account
              <ArrowRight size={15} />
            </Link>
            <Link
              href="/login?mode=login"
              className="press h-11 px-6 rounded-xl text-[14px] font-medium tracking-tight border border-[var(--material-border-strong)] bg-surface-2/60 hover:bg-surface-3/70 text-text-primary inline-flex items-center justify-center"
            >
              Ho già un account
            </Link>
          </div>
          <p className="text-[11px] text-text-faint mt-6 font-mono">
            Gratis durante la beta · Le password sono salvate solo come hash bcrypt
          </p>
        </section>

        {/* ── Feature grid ── */}
        <section className="mt-20 md:mt-32 max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-4">
          <Feature
            icon={<Mic size={16} className="text-accent" />}
            title="Trascrizione audio"
            body="Registra dal microfono o carica file audio (anche >25 MB, sì). La trascrizione finisce direttamente nelle tue note."
          />
          <Feature
            icon={<Sparkles size={16} className="text-accent" />}
            title="Enhance con un click"
            body="Trasforma appunti grezzi in note pulite e strutturate. Tu controlli lo stile via prompt personalizzati."
          />
          <Feature
            icon={<FileDown size={16} className="text-accent" />}
            title="Export PDF"
            body="Le tue note + il versione enhanced fianco a fianco, formattate per la stampa. Un click."
          />
        </section>

        {/* ── Privacy strip ── */}
        <section className="mt-20 md:mt-28 max-w-3xl mx-auto material-regular border rounded-2xl p-6 md:p-8">
          <h2 className="text-[14px] font-semibold text-text-emphasis tracking-tight mb-3">
            Privacy by design
          </h2>
          <p className="text-[13px] text-text-secondary leading-relaxed">
            Ogni utente ha il proprio archivio isolato — le note non vengono
            mai mescolate fra account. Le password vengono salvate solo come hash
            bcrypt (12 round); nemmeno noi possiamo recuperarle in chiaro. La
            sincronizzazione passa da un cookie httpOnly firmato (JWT, scadenza 30 giorni).
          </p>
        </section>

        {/* ── Suggestions strip ── */}
        <section className="mt-12 md:mt-16 max-w-3xl mx-auto text-center">
          <div className="inline-flex items-center gap-2 text-[12px] text-text-muted">
            <MessageCircle size={13} className="text-accent/70" />
            Hai un&apos;idea? I suggerimenti si inviano dall&apos;app, una volta dentro.
          </div>
        </section>
      </main>

      {/* ── Footer ── */}
      <footer className="px-6 md:px-10 py-6 border-t border-[var(--material-border)]">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3 text-[11px] text-text-faint font-mono">
          <span>© nota/enhance · v0 public beta</span>
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
