import Link from "next/link";

const STEPS = [
  { n: "1", title: "Create your account", body: "Sign up with Google or email. This login is only for this app." },
  { n: "2", title: "Connect your data", body: "Link Search Console and GA4 with the Google account that owns them, and choose which properties Claude may see." },
  { n: "3", title: "Ask Claude", body: "Add our connector in Claude, sign in once, then ask about clicks, queries, pages and traffic in plain language." },
];

const FEATURES = [
  { title: "Read-only by design", body: "We only request read access. Nothing in your Google accounts can be changed." },
  { title: "Only your data", body: "Every request is tied to your signed-in account. Other customers never see your properties or reports." },
  { title: "You choose what Claude sees", body: "Switch individual properties on or off for Claude at any time, or remove access in one click." },
  { title: "Credentials stay encrypted", body: "Google tokens are stored encrypted on the server and are never sent to your browser or to Claude." },
];

export default function HomePage() {
  return (
    <main>
      <section className="mx-auto max-w-6xl px-5 pb-10 pt-20 sm:pt-28">
        <p className="inline-block rounded-full px-3 py-1 text-xs" style={{ border: "1px solid var(--line)", color: "var(--teal)" }}>
          Search Console + GA4 for Claude
        </p>
        <h1 className="mt-6 max-w-4xl text-4xl font-medium leading-[1.1] tracking-tight sm:text-6xl">
          Your next SEO decision
          <br />
          <span className="accent">starts with one question.</span>
        </h1>
        <p className="muted mt-6 max-w-2xl text-lg">
          Connect your Search Console and Google Analytics 4 once. Then ask Claude what changed, what is working and what to fix next,
          answered from your real data.
        </p>
        <div className="mt-9 flex flex-wrap gap-3">
          <Link href="/signup" className="btn-primary !px-7 !py-3.5 text-base">
            Get started free <span aria-hidden>↗</span>
          </Link>
          <Link href="/mcp" className="btn-ghost !px-7 !py-3.5 text-base">
            How the MCP connector works
          </Link>
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 pt-20">
        <h2 className="text-2xl font-medium sm:text-3xl">
          Up and running in <span className="accent">three steps</span>
        </h2>
        <ol className="mt-8 grid gap-4 md:grid-cols-3">
          {STEPS.map((s) => (
            <li key={s.n} className="card">
              <span className="flex h-9 w-9 items-center justify-center rounded-full text-sm font-semibold" style={{ background: "var(--brand)" }}>
                {s.n}
              </span>
              <h3 className="mt-4 text-lg font-medium">{s.title}</h3>
              <p className="muted mt-2 text-sm leading-relaxed">{s.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="mx-auto max-w-6xl px-5 pt-20">
        <h2 className="text-2xl font-medium sm:text-3xl">
          Built to be <span className="accent">safe</span> with your data
        </h2>
        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {FEATURES.map((f) => (
            <div key={f.title} className="card">
              <h3 className="text-lg font-medium">{f.title}</h3>
              <p className="muted mt-2 text-sm leading-relaxed">{f.body}</p>
            </div>
          ))}
        </div>
      </section>

      <section className="mx-auto max-w-6xl px-5 pt-20">
        <div className="card flex flex-col items-start gap-5 !p-10 sm:flex-row sm:items-center sm:justify-between">
          <div>
            <h2 className="text-2xl font-medium sm:text-3xl">
              Ready to ask your <span className="accent">first question?</span>
            </h2>
            <p className="muted mt-2">Create an account and connect your first property in a few minutes.</p>
          </div>
          <Link href="/signup" className="btn-primary !px-7 !py-3.5 text-base">
            Create account <span aria-hidden>↗</span>
          </Link>
        </div>
      </section>
    </main>
  );
}
