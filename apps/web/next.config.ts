import { existsSync } from "node:fs";
import { resolve } from "node:path";
import type { NextConfig } from "next";

// Share one root-level .env.local between the web app and the MCP server.
const rootEnv = resolve(import.meta.dirname, "../../.env.local");
if (existsSync(rootEnv)) process.loadEnvFile(rootEnv);

const nextConfig: NextConfig = {
  outputFileTracingRoot: resolve(import.meta.dirname, "../.."),
  poweredByHeader: false,
  // The setup guide used to live at /mcp.
  redirects: async () => [{ source: "/mcp", destination: "/mcp-guide", permanent: true }],
  headers: async () => [
    {
      source: "/:path*",
      headers: [
        { key: "X-Content-Type-Options", value: "nosniff" },
        { key: "X-Frame-Options", value: "DENY" },
        { key: "Referrer-Policy", value: "strict-origin-when-cross-origin" },
        // Browsers ignore HSTS over plain http (localhost), so this only takes effect on the real https site.
        // No includeSubDomains/preload: the MCP server lives on a sibling subdomain and manages its own HTTPS.
        { key: "Strict-Transport-Security", value: "max-age=31536000" },
        { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=(), usb=()" },
        // A deliberately partial policy: framing, plugins and <base> hijacking are blocked. script-src and form-action are
        // left out because Next.js uses inline scripts and the consent form redirects to Claude's callback address.
        { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; object-src 'none'" },
      ],
    },
  ],
};

export default nextConfig;
