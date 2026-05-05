"use client";

import Link from "next/link";
import { useEffect } from "react";
import { useRouter } from "next/navigation";
import { ArrowRight } from "lucide-react";

// Public landing page — shown to unauthenticated visitors. Authenticated
// users are redirected to "/" (the app) on mount, so a logged-in user
// hitting /welcome by mistake doesn't land on a marketing page that no
// longer applies to them.
//
// Layout follows the dominant pattern in serious minimalist SaaS landings
// (Linear, Vercel, Raycast, Stripe): one viewport-tall hero with a tight
// headline + sub + single primary CTA, then a numbered three-step
// explainer instead of icon-grid features, then a closing CTA, then a
// hairline footer. No badges, no buzzwords, no implementation jargon.
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
        <Link
          href="/login?mode=login"
          className="press text-[13px] tracking-tight text-text-secondary hover:text-text-primary"
        >
          Accedi
        </Link>
      </header>

      <main className="flex-1 flex flex-col">
        {/* ── Hero ── */}
        <section className="px-6 md:px-10 pt-16 md:pt-32 pb-20 md:pb-28">
          <div className="max-w-3xl mx-auto text-center">
            <h1 className="text-[40px] sm:text-5xl md:text-6xl font-bold tracking-tight text-text-emphasis leading-[1.05] mb-7">
              Niente più appunti{" "}
              <span className="text-accent">da ricopiare</span>.
            </h1>
            <p className="text-[16px] md:text-[18px] text-text-secondary leading-relaxed max-w-xl mx-auto mb-10">
              Registri il prof o scrivi quello che vuoi. Diventa una pagina
              pulita, pronta da rileggere quando arriva l&apos;esame.
            </p>
            <Link
              href="/login?mode=register"
              className="btn-premium-accent press h-12 px-7 rounded-xl text-[14px] font-medium tracking-tight inline-flex items-center justify-center gap-2"
            >
              Inizia
              <ArrowRight size={15} />
            </Link>
          </div>
        </section>

        {/* ── How it works ──
            Three numbered steps in a single row on desktop. Mono-font numerals
            do the visual heavy lifting in place of icons, the same trick
            Linear and Stripe use. Each step is one concrete sentence — no
            icons, no boxed cards, just a number, a verb, and an outcome. */}
        <section className="px-6 md:px-10 pb-24 md:pb-32">
          <div className="max-w-5xl mx-auto grid grid-cols-1 md:grid-cols-3 gap-10 md:gap-12">
            <Step
              n="01"
              title="Registri o scrivi"
              body="Apri l'app in aula. Registri quello che dice il prof, butti giù due righe quando ti viene."
            />
            <Step
              n="02"
              title="Si sistema da solo"
              body="A fine giornata trovi una pagina ordinata. Lo stile lo decidi tu."
            />
            <Step
              n="03"
              title="Lo apri quando serve"
              body="Telefono, laptop, PDF. La sera prima dell'esame, apri e ripassi."
            />
          </div>
        </section>

        {/* ── Closing CTA ──
            Repeat the primary call to action after the explainer. Same
            wording as the hero so visitors who scrolled past once recognise
            the button instantly. */}
        <section className="px-6 md:px-10 pb-24 md:pb-32">
          <div className="max-w-2xl mx-auto text-center">
            <h2 className="text-2xl md:text-3xl font-semibold tracking-tight text-text-emphasis mb-7">
              Provalo con la prossima lezione.
            </h2>
            <Link
              href="/login?mode=register"
              className="btn-premium-accent press h-11 px-6 rounded-xl text-[14px] font-medium tracking-tight inline-flex items-center justify-center gap-2"
            >
              Crea il tuo account
              <ArrowRight size={15} />
            </Link>
          </div>
        </section>
      </main>

      {/* ── Footer ── */}
      <footer className="px-6 md:px-10 py-6 border-t border-[var(--material-border)]">
        <div className="max-w-5xl mx-auto flex flex-col md:flex-row items-center justify-between gap-3 text-[11px] text-text-faint">
          <span>© nota/enhance</span>
          <div className="flex items-center gap-5">
            <Link href="/login?mode=login" className="hover:text-text-secondary">Accedi</Link>
            <Link href="/login?mode=register" className="hover:text-text-secondary">Registrati</Link>
          </div>
        </div>
      </footer>
    </div>
  );
}

function Step({ n, title, body }: { n: string; title: string; body: string }) {
  return (
    <div>
      <div className="font-mono text-[12px] text-accent tracking-[0.18em] mb-3">
        {n}
      </div>
      <h3 className="text-[16px] font-semibold tracking-tight text-text-emphasis mb-2">
        {title}
      </h3>
      <p className="text-[13.5px] text-text-secondary leading-relaxed">
        {body}
      </p>
    </div>
  );
}
