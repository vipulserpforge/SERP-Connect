import Link from "next/link";
import { signOutAction } from "@/app/actions";
import { Logo } from "@/components/logo";
import { MCP_URL } from "@/lib/mcp-url";
import { getSessionUser } from "@/lib/server";

const NAV: Array<{ href: string; label: string; external?: boolean }> = [
  { href: "/", label: "Home" },
  { href: MCP_URL, label: "MCP", external: true },
  { href: "/mcp-guide", label: "Guide" },
  { href: "/privacy", label: "Privacy" },
];

/** One nav entry: the MCP address is another site, so it opens in a new tab. */
function NavLink({ item, className }: { item: (typeof NAV)[number]; className: string }) {
  return item.external ? (
    <a href={item.href} target="_blank" rel="noopener noreferrer" className={className}>
      {item.label}
    </a>
  ) : (
    <Link href={item.href} className={className}>
      {item.label}
    </Link>
  );
}

const navLink = "rounded-lg px-3 py-2 text-sm muted transition hover:text-white";

/** Public header on every page: floating glass bar, inline nav on desktop, a no-script menu on phones. */
export async function SiteHeader() {
  let signedIn = false;
  try {
    await getSessionUser();
    signedIn = true;
  } catch {
    signedIn = false;
  }
  return (
    <header className="sticky top-0 z-30 px-3 pt-3 sm:px-5">
      <div
        className="mx-auto max-w-6xl rounded-2xl backdrop-blur-xl"
        style={{ border: "1px solid var(--line)", background: "rgba(8,24,22,0.72)", boxShadow: "0 10px 40px rgba(0,0,0,0.3)" }}
      >
        <div className="flex items-center justify-between gap-3 px-4 py-2.5 sm:px-5">
          <Link href="/" aria-label="SERP Connect home" className="shrink-0 rounded-lg">
            <Logo size={38} tagline />
          </Link>

          <nav aria-label="Main" className="hidden items-center gap-1 lg:flex">
            {NAV.map((n) => (
              <NavLink key={n.label} item={n} className={navLink} />
            ))}
          </nav>

          <div className="hidden items-center gap-2 lg:flex">
            {signedIn ? (
              <>
                <form action={signOutAction}>
                  <button className={navLink}>Sign out</button>
                </form>
                <Link href="/dashboard" className="btn-primary">
                  Dashboard
                </Link>
              </>
            ) : (
              <>
                <Link href="/login" className={navLink}>
                  Login
                </Link>
                <Link href="/signup" className="btn-primary">
                  Get started
                </Link>
              </>
            )}
          </div>

          {/* Phones and tablets: a menu that works without JavaScript. */}
          <details className="group relative lg:hidden">
            <summary
              aria-label="Menu"
              className="flex h-11 w-11 cursor-pointer items-center justify-center rounded-xl transition hover:bg-white/10"
              style={{ border: "1px solid var(--line)" }}
            >
              <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" aria-hidden="true">
                <path className="group-open:hidden" d="M4 7h16M4 12h16M4 17h16" />
                <path className="hidden group-open:block" d="M6 6l12 12M18 6L6 18" />
              </svg>
            </summary>
            <nav
              aria-label="Mobile"
              className="absolute right-0 top-14 w-[min(86vw,320px)] rounded-2xl p-3"
              style={{ border: "1px solid var(--line)", background: "rgba(8,24,22,0.97)", boxShadow: "0 24px 60px rgba(0,0,0,0.5)" }}
            >
              {NAV.map((n) => (
                <NavLink key={n.label} item={n} className="block rounded-xl px-3 py-3 text-base hover:bg-white/10" />
              ))}
              <div className="mt-2 grid gap-2 border-t pt-3" style={{ borderColor: "var(--line)" }}>
                {signedIn ? (
                  <>
                    <Link href="/dashboard" className="btn-primary">
                      Dashboard
                    </Link>
                    <form action={signOutAction}>
                      <button className="btn-ghost w-full">Sign out</button>
                    </form>
                  </>
                ) : (
                  <>
                    <Link href="/signup" className="btn-primary">
                      Get started
                    </Link>
                    <Link href="/login" className="btn-ghost">
                      Login
                    </Link>
                  </>
                )}
              </div>
            </nav>
          </details>
        </div>
      </div>
    </header>
  );
}
