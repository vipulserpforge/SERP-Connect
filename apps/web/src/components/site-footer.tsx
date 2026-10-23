import Link from "next/link";
import { Logo } from "@/components/logo";

const COLUMNS = [
  {
    title: "Product",
    links: [
      { href: "/#how", label: "How it works" },
      { href: "/#security", label: "Security" },
      { href: "/#faq", label: "FAQ" },
      { href: "/mcp", label: "MCP connector" },
    ],
  },
  {
    title: "Account",
    links: [
      { href: "/login", label: "Login" },
      { href: "/signup", label: "Create account" },
      { href: "/dashboard", label: "Dashboard" },
    ],
  },
  {
    title: "Company",
    links: [
      { href: "https://serpforge.io", label: "SERP Forge" },
      { href: "/privacy", label: "Privacy policy" },
    ],
  },
];

export function SiteFooter() {
  return (
    <footer className="mt-24 sm:mt-32" style={{ borderTop: "1px solid var(--line)", background: "rgba(0,0,0,0.25)" }}>
      <div className="container-x grid gap-10 py-12 md:grid-cols-[1.4fr_2fr] md:py-16">
        <div>
          <Link href="/" aria-label="SERP Connect home" className="inline-block rounded-lg">
            <Logo size={42} tagline />
          </Link>
          <p className="muted mt-4 max-w-sm text-sm leading-relaxed">
            Ask Claude about your Search Console, GA4, Clarity and Bing data. Read-only, private to your account.
          </p>
          <Link href="/signup" className="btn-primary mt-6">
            Get started free <span aria-hidden="true">↗</span>
          </Link>
        </div>
        <nav aria-label="Footer" className="grid grid-cols-2 gap-8 sm:grid-cols-3">
          {COLUMNS.map((c) => (
            <div key={c.title}>
              <h2 className="text-sm font-medium">{c.title}</h2>
              <ul className="mt-4 space-y-1">
                {c.links.map((l) => (
                  <li key={l.href}>
                    <Link href={l.href} className="muted inline-flex min-h-9 items-center text-sm transition hover:text-white">
                      {l.label}
                    </Link>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </nav>
      </div>
      <div style={{ borderTop: "1px solid var(--line)" }}>
        <div className="container-x flex flex-col gap-2 py-5 text-xs muted sm:flex-row sm:items-center sm:justify-between">
          <p>© {new Date().getFullYear()} SERP Forge. All rights reserved.</p>
          <p>Read-only access. Your Google accounts are never modified.</p>
        </div>
      </div>
    </footer>
  );
}
