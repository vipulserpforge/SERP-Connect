import Image from "next/image";
import Link from "next/link";

export function SiteFooter() {
  return (
    <footer className="mt-24 border-t" style={{ borderColor: "var(--line)" }}>
      <div className="mx-auto flex max-w-6xl flex-col gap-6 px-5 py-10 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <Image src="/logo-serp-connect.svg" alt="SERP Connect by SERP Forge" width={103} height={36} unoptimized />
          <p className="muted mt-3 max-w-xs text-sm">Your Search Console and GA4 data, answered in plain language by Claude.</p>
        </div>
        <nav className="muted flex flex-wrap gap-x-6 gap-y-2 text-sm">
          <Link href="/" className="hover:text-white">Home</Link>
          <Link href="/mcp" className="hover:text-white">MCP</Link>
          <Link href="/login" className="hover:text-white">Login</Link>
          <Link href="/signup" className="hover:text-white">Sign up</Link>
          <Link href="/privacy" className="hover:text-white">Privacy policy</Link>
        </nav>
      </div>
      <p className="muted border-t px-5 py-5 text-center text-xs" style={{ borderColor: "var(--line)" }}>
        © {new Date().getFullYear()} SERP Forge. Read-only access. Your Google credentials never leave our servers.
      </p>
    </footer>
  );
}
