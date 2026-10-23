import Link from "next/link";
import { signOutAction } from "@/app/actions";
import { Logo } from "@/components/logo";
import { getSessionUser } from "@/lib/server";

/** Public header on every page. Shows Dashboard/Sign out when a valid session exists, otherwise Login/Sign up. */
export async function SiteHeader() {
  let signedIn = false;
  try {
    await getSessionUser();
    signedIn = true;
  } catch {
    signedIn = false;
  }
  return (
    <header className="sticky top-0 z-20 border-b backdrop-blur" style={{ borderColor: "var(--line)", background: "rgba(7,17,15,0.75)" }}>
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-5 py-3.5">
        <Link href="/" aria-label="SERP Connect home">
          <Logo size={36} />
        </Link>
        <nav className="flex items-center gap-1.5 text-sm sm:gap-3">
          <Link href="/mcp" className="muted rounded-lg px-3 py-2 hover:text-white">
            MCP
          </Link>
          {signedIn ? (
            <>
              <Link href="/dashboard" className="btn-ghost !py-2">
                Dashboard
              </Link>
              <form action={signOutAction}>
                <button className="muted rounded-lg px-3 py-2 hover:text-white">Sign out</button>
              </form>
            </>
          ) : (
            <>
              <Link href="/login" className="muted rounded-lg px-3 py-2 hover:text-white">
                Login
              </Link>
              <Link href="/signup" className="btn-primary !py-2">
                Sign up
              </Link>
            </>
          )}
        </nav>
      </div>
    </header>
  );
}
