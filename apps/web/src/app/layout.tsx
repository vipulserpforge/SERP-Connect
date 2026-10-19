import type { Metadata } from "next";
import { Outfit, Playfair_Display } from "next/font/google";
import type { ReactNode } from "react";
import { SiteFooter } from "@/components/site-footer";
import { SiteHeader } from "@/components/site-header";
import "./globals.css";

const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit", display: "swap" });
const playfair = Playfair_Display({ subsets: ["latin"], style: "italic", variable: "--font-playfair", display: "swap" });

export const metadata: Metadata = {
  title: { default: "SERP Forge SEO Connector", template: "%s · SERP Forge SEO Connector" },
  description: "Ask Claude about your Search Console and GA4 data. Read-only, private to your account.",
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${playfair.variable}`}>
      <body className="flex min-h-screen flex-col antialiased" suppressHydrationWarning>
        <SiteHeader />
        <div className="flex-1">{children}</div>
        <SiteFooter />
      </body>
    </html>
  );
}
