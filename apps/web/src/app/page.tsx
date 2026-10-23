import Link from "next/link";
import { HeroFlow } from "@/components/hero-flow";
import { PromptDemo } from "@/components/prompt-demo";

const SOURCES = [
  { mark: "GSC", name: "Search Console", body: "Clicks, impressions, CTR and position by query, page, country and device, with up to 16 months of history." },
  { mark: "GA4", name: "Google Analytics 4", body: "Users, sessions and key events in each property's own time zone, filtered to organic traffic when you ask." },
  { mark: "CL", name: "Microsoft Clarity", body: "How visitors behave over the last 24 to 72 hours: engagement, rage clicks, scroll depth and errors." },
  { mark: "BI", name: "Bing Webmaster", body: "Bing traffic, queries and crawl statistics, always kept apart from Google's numbers." },
];

const STEPS = [
  { title: "Create your account", body: "Sign up with Google or email. This login is only for this app.", ui: "account" },
  { title: "Connect your data", body: "Link Search Console, GA4, Clarity or Bing, then choose which properties Claude may see.", ui: "connect" },
  { title: "Ask Claude", body: "Add the connector in Claude, sign in once, and ask in plain language.", ui: "claude" },
] as const;

const SAFE = [
  { title: "Read-only by design", body: "We only request read access. Nothing in your Google accounts can be changed." },
  { title: "Only your data", body: "Every request is tied to your signed-in account. Other customers never see your properties or reports." },
  { title: "You choose what Claude sees", body: "Switch individual properties on or off for Claude at any time, or remove its access in one click." },
  { title: "Credentials stay encrypted", body: "Google tokens are stored encrypted on the server and are never sent to your browser or to Claude." },
];

const FAQ = [
  { q: "Can Claude change anything in my accounts?", a: "No. Connections use read-only permissions and every tool in the connector only reads data." },
  { q: "Which data sources work?", a: "Search Console and GA4 through Google sign-in, Microsoft Clarity with a project token, and Bing Webmaster Tools where it is switched on for your account." },
  { q: "How do I add it to Claude?", a: "In Claude open Settings, then Connectors, then Add custom connector. Paste the address from the MCP page, sign in on this site and click Allow." },
  { q: "Can I limit what Claude sees?", a: "Yes. Turn each property on or off for Claude on the dashboard, or remove Claude's access entirely in one click." },
  { q: "How fresh is the data?", a: "Search Console is finalised about two days behind. GA4 follows each property's time zone. Clarity only covers the last 72 hours. Results are saved for minutes to hours, so repeat questions are fast." },
  { q: "Is it free?", a: "You can create an account and connect your first property for free." },
];

function Check() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" className="mt-0.5 shrink-0" style={{ color: "var(--teal)" }}>
      <circle cx="12" cy="12" r="10" strokeWidth="1.5" />
      <path d="M8 12.5l3 3 5-6" />
    </svg>
  );
}

/** Tiny interface fragments, drawn in HTML, that show each step instead of describing it. */
function StepUi({ kind }: { kind: (typeof STEPS)[number]["ui"] }) {
  return (
    <div data-ui aria-hidden="true" className="rounded-xl p-4" style={{ background: "rgba(0,0,0,0.32)", border: "1px solid var(--line)" }}>
      {kind === "account" && (
        <div className="space-y-2.5">
          <div className="flex h-9 items-center justify-center rounded-lg text-xs font-medium" style={{ border: "1px solid var(--line)", background: "var(--surface)" }}>
            Continue with Google
          </div>
          <div className="h-9 rounded-lg px-3 text-xs leading-9 muted" style={{ border: "1px solid var(--line)" }}>you@company.com</div>
          <div className="flex h-9 items-center justify-center rounded-lg text-xs font-semibold" style={{ background: "var(--brand)", color: "#1a0e00" }}>Sign up</div>
        </div>
      )}
      {kind === "connect" && (
        <ul className="space-y-2.5 text-xs">
          {[
            ["sc-domain:example.com", true],
            ["https://blog.example.com/", true],
            ["GA4 · Example site", false],
          ].map(([name, on]) => (
            <li key={String(name)} className="flex items-center justify-between gap-3 rounded-lg px-3 py-2.5" style={{ background: "var(--surface)" }}>
              <span className="truncate">{String(name)}</span>
              <span className={`flex h-5 w-9 shrink-0 items-center rounded-full px-0.5 ${on ? "justify-end" : "justify-start"}`} style={{ background: on ? "var(--teal-strong)" : "rgba(255,255,255,0.2)" }}>
                <span className="h-4 w-4 rounded-full bg-white" />
              </span>
            </li>
          ))}
        </ul>
      )}
      {kind === "claude" && (
        <div className="space-y-2.5 text-xs">
          <p className="rounded-lg px-3 py-2.5 muted" style={{ background: "var(--surface)" }}>Your connector address</p>
          <p className="rounded-lg px-3 py-2.5" style={{ background: "rgba(255,255,255,0.1)" }}>“Which pages lost clicks this month?”</p>
          <div className="flex h-9 items-center justify-center rounded-lg font-semibold" style={{ background: "var(--brand)", color: "#1a0e00" }}>Allow</div>
        </div>
      )}
    </div>
  );
}

export default function HomePage() {
  return (
    <main>
      {/* ───────── Hero: the question and its answer ───────── */}
      <section className="container-x relative grid items-center gap-12 pb-16 pt-14 sm:pt-20 lg:grid-cols-[0.92fr_1.08fr] lg:gap-10 lg:pb-28 lg:pt-24">
        <div>
          <p className="pill enter" style={{ color: "var(--teal)", ["--i" as string]: 0 }}>
            Search Console + GA4 + Clarity + Bing, for Claude
          </p>
          <h1 className="enter mt-6 text-[2.6rem] font-medium leading-[1.04] tracking-tight sm:text-6xl" style={{ ["--i" as string]: 1 }}>
            Ask Claude about your <span className="accent">SEO data.</span>
          </h1>
          <p className="muted enter mt-6 max-w-xl text-lg leading-relaxed sm:text-xl" style={{ ["--i" as string]: 2 }}>
            Connect your sources once. Claude answers from your real numbers: what changed, what is working and what to fix next.
          </p>
          <div className="enter mt-9 flex flex-col gap-3 sm:flex-row" style={{ ["--i" as string]: 3 }}>
            <Link href="/signup" className="btn-primary !min-h-12 !px-7 text-base">
              Get started free <span aria-hidden="true">↗</span>
            </Link>
            <Link href="#how" className="btn-ghost !min-h-12 !px-7 text-base">
              See how it works
            </Link>
          </div>
          <p className="enter mt-5 text-sm muted" style={{ ["--i" as string]: 4 }}>
            <span style={{ color: "var(--brand-hover)" }}>Read-only</span> access · Free to start · Your data stays yours
          </p>
        </div>

        <div className="enter relative mx-auto w-full max-w-xl lg:max-w-none" style={{ ["--i" as string]: 3 }}>
          <div className="glow-orb" style={{ width: "62%", aspectRatio: "1", right: "-6%", top: "26%" }} aria-hidden="true" />
          {/* The panes peek out from behind the card's corners, so their bright rims never cross the text. */}
          <div className="glass-shape drift-a" style={{ width: "50%", aspectRatio: "1", right: "-10%", top: "-11%" }} aria-hidden="true" />
          <div className="glass-shape drift-b" style={{ width: "42%", aspectRatio: "1", left: "-13%", bottom: "-12%" }} aria-hidden="true" />
          <div className="glass-bead drift-b" style={{ width: "clamp(36px, 7%, 64px)", aspectRatio: "1", right: "4%", bottom: "-3%" }} aria-hidden="true" />
          <div className="relative z-10 py-8 sm:py-12">
            <HeroFlow />
          </div>
        </div>
      </section>

      {/* ───────── Sources: one conversation, four tools ───────── */}
      <section aria-labelledby="sources-h" className="py-14 sm:py-20" style={{ background: "linear-gradient(180deg, rgba(11,38,35,0.55), rgba(11,38,35,0.15))" }}>
        <div className="container-x">
          <h2 id="sources-h" className="reveal max-w-3xl text-3xl font-medium leading-tight tracking-tight sm:text-5xl">
            Four tools, <span className="accent">one conversation.</span>
          </h2>
          <p className="muted reveal mt-4 max-w-2xl text-lg">Stop switching tabs. Ask across your SEO and analytics tools in the same chat.</p>
          <ul className="mt-10 grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
            {SOURCES.map((s, i) => (
              <li key={s.name} className="reveal lift rounded-2xl p-6" style={{ background: "var(--surface)", border: "1px solid var(--line)", ["--i" as string]: i }}>
                <span className="flex h-11 w-11 items-center justify-center rounded-xl text-sm font-semibold" style={{ background: "rgba(15,163,163,0.2)", color: "var(--teal)" }}>
                  {s.mark}
                </span>
                <h3 className="mt-5 text-xl font-medium">{s.name}</h3>
                <p className="muted mt-2 text-sm leading-relaxed">{s.body}</p>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ───────── Ask: the live example ───────── */}
      <section aria-labelledby="ask-h" className="container-x pt-20 sm:pt-28">
        <h2 id="ask-h" className="reveal max-w-3xl text-3xl font-medium leading-tight tracking-tight sm:text-5xl">
          Ask in <span className="accent">plain words.</span> Get the table.
        </h2>
        <p className="muted reveal mt-4 max-w-2xl text-lg">Pick a question to see the kind of answer Claude builds from your own properties.</p>
        <div className="reveal mt-10">
          <PromptDemo />
        </div>
      </section>

      {/* ───────── How it works ───────── */}
      <section id="how" aria-labelledby="how-h" className="container-x pt-20 sm:pt-28">
        <h2 id="how-h" className="reveal max-w-3xl text-3xl font-medium leading-tight tracking-tight sm:text-5xl">
          Up and running in <span className="accent">minutes.</span>
        </h2>
        <ol className="mt-10 grid gap-5 md:grid-cols-3">
          {STEPS.map((s, i) => (
            <li key={s.title} className="reveal flex flex-col rounded-2xl p-5 sm:p-6" style={{ background: "var(--surface)", border: "1px solid var(--line)", ["--i" as string]: i }}>
              <StepUi kind={s.ui} />
              <h3 className="mt-6 text-xl font-medium">{s.title}</h3>
              <p className="muted mt-2 text-sm leading-relaxed sm:text-base">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      {/* ───────── Security ───────── */}
      <section id="security" aria-labelledby="sec-h" className="container-x pt-20 sm:pt-28">
        <div className="grid gap-10 lg:grid-cols-[0.9fr_1.1fr] lg:gap-16">
          <div className="reveal">
            <h2 id="sec-h" className="text-3xl font-medium leading-tight tracking-tight sm:text-5xl">
              Built to be <span className="accent">safe</span> with your data.
            </h2>
            <p className="muted mt-4 max-w-md text-lg">Read-only access, private to your account, and you stay in control of what Claude can see.</p>
            <div data-ui className="mt-8 rounded-2xl p-5" style={{ background: "rgba(0,0,0,0.3)", border: "1px solid var(--line)" }}>
              <p className="text-sm font-medium">Permissions requested from Google</p>
              <ul className="mt-3 space-y-2 text-sm">
                <li className="flex items-center justify-between gap-3">
                  <span>Search Console</span>
                  <code className="tone-ok rounded-md px-2 py-0.5 text-xs">read-only</code>
                </li>
                <li className="flex items-center justify-between gap-3">
                  <span>Google Analytics</span>
                  <code className="tone-ok rounded-md px-2 py-0.5 text-xs">read-only</code>
                </li>
              </ul>
            </div>
          </div>
          <ul className="grid gap-6">
            {SAFE.map((f, i) => (
              <li key={f.title} className="reveal flex gap-4" style={{ ["--i" as string]: i }}>
                <Check />
                <div>
                  <h3 className="text-xl font-medium">{f.title}</h3>
                  <p className="muted mt-1.5 leading-relaxed">{f.body}</p>
                </div>
              </li>
            ))}
          </ul>
        </div>
      </section>

      {/* ───────── FAQ ───────── */}
      <section id="faq" aria-labelledby="faq-h" className="container-x pt-20 sm:pt-28">
        <div className="grid gap-10 lg:grid-cols-[0.8fr_1.2fr] lg:gap-16">
          <h2 id="faq-h" className="reveal text-3xl font-medium leading-tight tracking-tight sm:text-5xl">
            Questions, <span className="accent">answered.</span>
          </h2>
          <div className="space-y-3">
            {FAQ.map((f) => (
              <details key={f.q} className="group rounded-2xl" style={{ background: "var(--surface)", border: "1px solid var(--line)" }}>
                <summary className="flex min-h-14 cursor-pointer items-center justify-between gap-4 px-5 py-4 text-base font-medium sm:text-lg">
                  {f.q}
                  <svg className="chev shrink-0 transition-transform duration-200" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
                    <path d="M6 9l6 6 6-6" />
                  </svg>
                </summary>
                <p className="muted px-5 pb-5 leading-relaxed">{f.a}</p>
              </details>
            ))}
          </div>
        </div>
      </section>

      {/* ───────── Final call ───────── */}
      <section className="container-x pt-20 sm:pt-28">
        <div className="reveal relative overflow-hidden rounded-3xl px-6 py-14 text-center sm:px-12 sm:py-20" style={{ border: "1px solid var(--line)", background: "linear-gradient(135deg, rgba(15,163,163,0.2), rgba(11,38,35,0.6))" }}>
          <div className="glow-orb" style={{ width: "50%", aspectRatio: "1", left: "25%", top: "40%" }} aria-hidden="true" />
          <div className="relative">
            <h2 className="mx-auto max-w-2xl text-3xl font-medium leading-tight tracking-tight sm:text-5xl">
              Ready to ask your <span className="accent">first question?</span>
            </h2>
            <p className="muted mx-auto mt-4 max-w-lg text-lg">Create an account and connect your first property in a few minutes.</p>
            <div className="mt-8 flex flex-col justify-center gap-3 sm:flex-row">
              <Link href="/signup" className="btn-primary !min-h-12 !px-8 text-base">
                Create account <span aria-hidden="true">↗</span>
              </Link>
              <Link href="/mcp-guide" className="btn-ghost !min-h-12 !px-8 text-base">
                Step-by-step setup guide
              </Link>
            </div>
          </div>
        </div>
      </section>
    </main>
  );
}
