import Link from "next/link";
import type { ReactNode } from "react";
import { CopyButton } from "@/components/copy-button";
import { MCP_URL } from "@/lib/mcp-url";

export const metadata = {
  title: "How to connect to Claude",
  description: "A simple step-by-step guide: create an account, connect Search Console, GA4, Clarity and Bing, and ask Claude about your website.",
};

const JUMP = [
  { id: "what", label: "What is this?" },
  { id: "account", label: "1. Account" },
  { id: "google", label: "2. Google" },
  { id: "clarity", label: "3. Clarity" },
  { id: "bing", label: "4. Bing" },
  { id: "claude", label: "5. Claude" },
  { id: "ask", label: "6. Ask" },
  { id: "help", label: "Help" },
];

const CAN_DO = [
  { name: "Google Search Console", body: "Which searches bring people to your site, which pages get clicks, and how your rankings change." },
  { name: "Google Analytics 4", body: "How many people visit, where they come from, which pages they read, and what they buy." },
  { name: "Microsoft Clarity", body: "How visitors behave on your pages: where they click, how far they scroll, and where they hit errors." },
  { name: "Bing Webmaster", body: "The same kind of search numbers, but from Bing." },
];

const PROMPTS = [
  "Which pages lost the most clicks last month?",
  "Which searches show my site a lot but get few clicks?",
  "Where does my website traffic come from? Compare with the previous month.",
  "Which pages bring the most visitors from Google search?",
  "How many people are on my site right now?",
  "Which products earned the most revenue in the last 28 days?",
  "Are new visitors coming back? Show weekly retention.",
  "How are visitors behaving on mobile over the last 3 days?",
];

function Part({ id, n, title, intro, children }: { id: string; n: string; title: string; intro: string; children: ReactNode }) {
  return (
    <section id={id} aria-labelledby={`${id}-h`} className="reveal pt-14 sm:pt-20">
      <div className="flex items-center gap-3">
        <span aria-hidden="true" className="flex h-9 min-w-9 items-center justify-center rounded-full px-2 text-sm font-semibold" style={{ background: "var(--brand)", color: "#1a0e00" }}>
          {n}
        </span>
        <h2 id={`${id}-h`} className="text-2xl font-medium tracking-tight sm:text-3xl">
          {title}
        </h2>
      </div>
      <p className="muted mt-3 max-w-2xl text-base leading-relaxed">{intro}</p>
      <div className="mt-6">{children}</div>
    </section>
  );
}

/** A short numbered list. Each item is one action. */
function Steps({ items }: { items: ReactNode[] }) {
  return (
    <ol className="grid gap-3">
      {items.map((item, i) => (
        <li key={i} className="flex gap-4 rounded-2xl p-4 sm:p-5" style={{ background: "var(--surface)", border: "1px solid var(--line)" }}>
          <span aria-hidden="true" className="flex h-7 w-7 shrink-0 items-center justify-center rounded-full text-xs font-semibold" style={{ background: "rgba(171,220,214,0.16)", color: "var(--teal)" }}>
            {i + 1}
          </span>
          <div className="min-w-0 text-base leading-relaxed">{item}</div>
        </li>
      ))}
    </ol>
  );
}

const B = ({ children }: { children: ReactNode }) => <strong className="font-semibold text-white">{children}</strong>;

function Tip({ children }: { children: ReactNode }) {
  return (
    <p className="alert mt-4" style={{ background: "rgba(15,163,163,0.12)", color: "var(--teal)" }}>
      <strong className="font-semibold">Tip: </strong>
      {children}
    </p>
  );
}

export default function McpGuidePage() {
  return (
    <main className="container-x pb-6 pt-12 sm:pt-20">
      <header className="max-w-3xl">
        <p className="pill enter" style={{ color: "var(--teal)", ["--i" as string]: 0 }}>
          Setup guide · about 15 minutes
        </p>
        <h1 className="enter mt-5 text-[2.5rem] font-medium leading-[1.05] tracking-tight sm:text-6xl" style={{ ["--i" as string]: 1 }}>
          Talk to Claude about <span className="accent">your website data.</span>
        </h1>
        <p className="muted enter mt-5 text-lg leading-relaxed" style={{ ["--i" as string]: 2 }}>
          Follow the steps below one by one. No technical knowledge needed. If you can copy and paste, you can do this.
        </p>
      </header>

      <nav aria-label="On this page" className="mt-8 flex flex-wrap gap-2">
        {JUMP.map((j) => (
          <a key={j.id} href={`#${j.id}`} className="btn-ghost !min-h-11 !px-4 !py-2 text-sm">
            {j.label}
          </a>
        ))}
      </nav>

      {/* ---- What is this ---- */}
      <section id="what" aria-labelledby="what-h" className="pt-14 sm:pt-20">
        <h2 id="what-h" className="text-2xl font-medium tracking-tight sm:text-3xl">
          What does SERP Connect do?
        </h2>
        <p className="mt-3 max-w-3xl text-lg leading-relaxed">
          SERP Connect is a bridge between <B>Claude</B> (the AI assistant) and the tools that measure your website. Once connected, you can simply <B>ask Claude questions in plain English</B> and it looks up the answer in your own data.
        </p>
        <div className="mt-6 grid gap-3 sm:grid-cols-2">
          {CAN_DO.map((c) => (
            <div key={c.name} className="card !p-5">
              <h3 className="text-lg font-medium">{c.name}</h3>
              <p className="muted mt-1 leading-relaxed">{c.body}</p>
            </div>
          ))}
        </div>
        <div className="mt-4 grid gap-3 sm:grid-cols-2">
          <div className="card !p-5">
            <h3 className="text-lg font-medium">Is it safe?</h3>
            <p className="muted mt-1 leading-relaxed">Yes. It can only <B>read</B> your numbers. It cannot change your website or your accounts. You choose what Claude can see, and you can disconnect any time.</p>
          </div>
          <div className="card !p-5">
            <h3 className="text-lg font-medium">What you need</h3>
            <ul className="muted mt-1 list-disc space-y-1 pl-5 leading-relaxed">
              <li>A Claude account that can add connectors (for example Claude Pro, Max, Team or Enterprise).</li>
              <li>Access to the tools you want to connect (you can skip any you do not use).</li>
            </ul>
          </div>
        </div>
      </section>

      {/* ---- 1 Account ---- */}
      <Part id="account" n="1" title="Create your account and log in" intro="This account is only for SERP Connect. It is separate from Claude and from Google.">
        <Steps
          items={[
            <>
              Open <Link href="/signup" className="text-[var(--teal)] underline underline-offset-4">the sign-up page</Link>.
            </>,
            <>
              Click <B>Continue with Google</B> for the quickest way. Or type your email and a password, then click <B>Create account</B>.
            </>,
            <>
              If we send you an email, open it and click the link to confirm. Then come back.
            </>,
            <>
              Next time, use <Link href="/login" className="text-[var(--teal)] underline underline-offset-4">Log in</Link>. You will land on your <B>Dashboard</B>. That is the page where you connect everything.
            </>,
          ]}
        />
      </Part>

      {/* ---- 2 Google ---- */}
      <Part id="google" n="2" title="Connect Google Search Console and Google Analytics 4" intro="Both are Google products, so they work the same way. Do the first one, then repeat for the second.">
        <h3 className="text-lg font-medium">Search Console</h3>
        <div className="mt-3">
          <Steps
            items={[
              <>
                On the Dashboard, find the card called <B>Google Search Console</B> and click <B>Connect</B>.
              </>,
              <>
                Choose the Google account that can see your website in Search Console. This is the account you use to look at your site's search results.
              </>,
              <>
                Click <B>Allow</B> (or <B>Continue</B>) when Google asks. We only ask to <B>view</B> your data.
              </>,
              <>
                You return to the Dashboard. Under the card you will see your websites. Click <B>Enable for Claude</B> next to each one you want Claude to use. The label changes to <B>Visible to Claude</B>.
              </>,
            ]}
          />
        </div>
        <h3 className="mt-8 text-lg font-medium">Google Analytics 4 (GA4)</h3>
        <div className="mt-3">
          <Steps
            items={[
              <>
                On the Dashboard, find the card called <B>Google Analytics 4</B> and click <B>Connect</B>.
              </>,
              <>
                Choose the Google account that can open your analytics, then click <B>Allow</B>.
              </>,
              <>
                Click <B>Enable for Claude</B> next to each analytics property you want to use.
              </>,
            ]}
          />
        </div>
        <Tip>If your list is empty, click <B>Refresh properties</B>. Still empty? That Google account has no access. Connect the account that does.</Tip>
      </Part>

      {/* ---- 3 Clarity ---- */}
      <Part id="clarity" n="3" title="Connect Microsoft Clarity" intro="Clarity does not use a login button. Instead you create a secret code (called a token) in Clarity and paste it into SERP Connect. Skip this part if you do not use Clarity.">
        <Steps
          items={[
            <>
              Open <B>clarity.microsoft.com</B>, sign in, and open the project (website) you want.
            </>,
            <>
              Click <B>Settings</B>, then <B>Data Export</B>, then <B>Generate new API token</B>. Only a project <B>admin</B> can do this.
            </>,
            <>
              Give the token any name, then <B>copy</B> it. Keep that window open for a moment.
            </>,
            <>
              Back on your SERP Connect Dashboard, open the <B>Microsoft Clarity</B> card. Type a name (for example your website name) and paste the token.
            </>,
            <>
              Click <B>Save token securely</B>. Your token is stored encrypted and is never shown again.
            </>,
          ]}
        />
        <Tip>Clarity only shares the last 1 to 3 days. For longer periods Claude will use Search Console and GA4 instead.</Tip>
      </Part>

      {/* ---- 4 Bing ---- */}
      <Part id="bing" n="4" title="Connect Bing Webmaster" intro="Bing can be connected by logging in, or with a secret code (API key). Your site must already be added and verified in Bing Webmaster Tools. Skip this part if you do not use Bing.">
        <h3 className="text-lg font-medium">Option A: log in with Bing (easiest)</h3>
        <div className="mt-3">
          <Steps
            items={[
              <>
                On the Dashboard, open the <B>Bing Webmaster Tools</B> card and click <B>Connect with Bing</B>.
              </>,
              <>
                Sign in with the Microsoft account that owns your site in Bing, then click <B>Accept</B>.
              </>,
              <>
                Click <B>Enable for Claude</B> next to each site you want to use.
              </>,
            ]}
          />
        </div>
        <h3 className="mt-8 text-lg font-medium">Option B: use an API key</h3>
        <p className="muted mt-2 text-sm">Use this if Option A is not available.</p>
        <div className="mt-3">
          <Steps
            items={[
              <>
                Open <B>bing.com/webmasters</B> and sign in.
              </>,
              <>
                Click the <B>gear icon (Settings)</B>, then <B>API access</B>. Accept the terms if asked, then click <B>Generate API Key</B> and <B>copy</B> it.
              </>,
              <>
                On the SERP Connect Dashboard, open the Bing card, click <B>Or use a Bing API key</B>, paste the key and save it.
              </>,
            ]}
          />
        </div>
        <Tip>Bing shows only sites you have verified. Not listed? Verify the site in Bing Webmaster Tools first, then click <B>Refresh sites</B>.</Tip>
      </Part>

      {/* ---- 5 Claude ---- */}
      <Part id="claude" n="5" title="Add SERP Connect to Claude" intro="Now tell Claude where to find your data. You only do this once.">
        <div className="rounded-2xl p-5 sm:p-6" style={{ border: "1px solid var(--line)", background: "rgba(9,26,24,0.85)" }}>
          <h3 className="text-sm font-medium">Your connector address</h3>
          <div className="mt-3 flex flex-col gap-3 sm:flex-row sm:items-center">
            <code className="min-w-0 flex-1 break-all rounded-xl px-4 py-3 text-base" style={{ background: "rgba(0,0,0,0.4)", color: "var(--teal)" }}>
              {MCP_URL}
            </code>
            <CopyButton text={MCP_URL} label="Copy address" />
          </div>
        </div>
        <div className="mt-4">
          <Steps
            items={[
              <>Click <B>Copy address</B> above.</>,
              <>
                Open <B>claude.ai</B> and log in. Click your name (bottom left), then <B>Settings</B>, then <B>Connectors</B>.
              </>,
              <>
                Click <B>Add custom connector</B>. For the name type <B>SERP Connect</B>. Paste the address you copied. Click <B>Add</B>.
              </>,
              <>
                Click <B>Connect</B> next to SERP Connect. A window opens on our website. Log in if asked, then click <B>Allow</B>.
              </>,
              <>
                Start a new chat. Click the <B>+</B> (or the tools icon) near the message box and make sure <B>SERP Connect</B> is switched on.
              </>,
            ]}
          />
        </div>
        <Tip>The menu names in Claude can look a little different on your screen. Look for <B>Connectors</B> in Settings.</Tip>
      </Part>

      {/* ---- 6 Ask ---- */}
      <Part id="ask" n="6" title="Ask your first question" intro="Type a question like you would ask a person. Claude picks the right tool and shows the answer with a short summary, a table and a suggested next step.">
        <ul className="grid gap-3 sm:grid-cols-2">
          {PROMPTS.map((p) => (
            <li key={p} className="rounded-2xl px-5 py-4 text-base" style={{ background: "rgba(255,255,255,0.08)" }}>
              “{p}”
            </li>
          ))}
        </ul>
        <p className="muted mt-4 max-w-2xl text-sm leading-relaxed">If you have more than one website, add its name to your question, for example “for example.com”.</p>
      </Part>

      {/* ---- Help ---- */}
      <section id="help" aria-labelledby="help-h" className="reveal pt-14 sm:pt-20">
        <h2 id="help-h" className="text-2xl font-medium tracking-tight sm:text-3xl">
          Something not working?
        </h2>
        <div className="mt-6 grid gap-3">
          {[
            { q: "Claude says my account needs to be reconnected", a: "Go to the Dashboard, find the card marked Needs attention, and click Reconnect (or Disconnect, then Connect again). Then ask Claude again." },
            { q: "Claude cannot see my website", a: "On the Dashboard, make sure the site says Visible to Claude. If not, click Enable for Claude." },
            { q: "Claude says there is no data", a: "Very new data can take a day or two to appear. Try a longer period, such as the last 28 days." },
            { q: "How do I stop sharing?", a: "On the Dashboard click Disconnect on any card. You can also remove SERP Connect from Claude's Connectors list at any time." },
          ].map((f) => (
            <details key={f.q} className="rounded-2xl" style={{ background: "var(--surface)", border: "1px solid var(--line)" }}>
              <summary className="flex min-h-11 cursor-pointer items-center justify-between gap-4 px-5 py-3 text-base font-medium">
                {f.q}
                <span aria-hidden="true" className="chev shrink-0 transition-transform">⌄</span>
              </summary>
              <p className="muted px-5 pb-4 leading-relaxed">{f.a}</p>
            </details>
          ))}
        </div>
      </section>

      <section className="flex flex-col gap-3 pt-14 sm:flex-row sm:pt-20">
        <Link href="/signup" className="btn-primary !min-h-12 !px-7 text-base">
          Create account
        </Link>
        <Link href="/dashboard" className="btn-ghost !min-h-12 !px-7 text-base">
          Go to dashboard
        </Link>
      </section>
    </main>
  );
}
