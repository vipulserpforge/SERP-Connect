import Image from "next/image";
import type { ReactNode } from "react";

/**
 * Hero artwork: your data sources flow into SERP Connect, which feeds your AI, while a sample question types itself out and
 * an answer appears. Built from HTML and SVG (not images) so it stays sharp and readable. Sizes are in design pixels on a
 * 700 x 560 canvas and scale with the container (`cqw`), so tablet and desktop keep the exact layout; phones get a stacked layout.
 * Animation is CSS-only and switches off for reduced motion, leaving the finished state on screen.
 */

const W = 700;
const H = 560;
const x = (px: number) => `${(px / W) * 100}%`;
const y = (px: number) => `${(px / H) * 100}%`;
/** A length in design pixels, scaled with the container width. */
const u = (px: number) => `${(px / W) * 100}cqw`;

type Brand = "gsc" | "ga4" | "bing" | "clarity" | "claude" | "chatgpt";

/** Official product marks, kept in /public/logos. */
const LOGO: Record<Brand, { src: string; alt: string }> = {
  gsc: { src: "/logos/gsc.png", alt: "Google Search Console" },
  ga4: { src: "/logos/ga4.png", alt: "Google Analytics 4" },
  bing: { src: "/logos/bing.png", alt: "Bing Webmaster Tools" },
  clarity: { src: "/logos/clarity.png", alt: "Microsoft Clarity" },
  claude: { src: "/logos/claude.png", alt: "Claude" },
  chatgpt: { src: "/logos/chatgpt.png", alt: "ChatGPT" },
};

function Mark({ src, alt, fill = false }: { src: string; alt: string; fill?: boolean }) {
  // Fixed local files at 160px: the image optimizer adds nothing for them.
  return <Image src={src} alt={alt} width={160} height={160} unoptimized style={{ width: "100%", height: "100%", objectFit: fill ? "cover" : "contain", display: "block" }} />;
}

const SOURCES: Array<{ name: string; brand: Brand }> = [
  { name: "Search Console", brand: "gsc" },
  { name: "Analytics 4", brand: "ga4" },
  { name: "Bing Webmaster", brand: "bing" },
  { name: "Clarity", brand: "clarity" },
];
const AIS: Array<{ name: string; brand: Brand }> = [
  { name: "Claude", brand: "claude" },
  { name: "ChatGPT", brand: "chatgpt" },
];

const QUESTION = "Which pages drive the most organic traffic?";
const ANSWER = "Spam Score Checker leads, 360 clicks";

/** Data sources sit on a white tile (their marks are made for light grounds); AI apps' marks are full-bleed app icons. */
function Tile({ brand, bare = false, size, radius, inset }: { brand: Brand; bare?: boolean; size: string; radius: string; inset: string }) {
  const logo = LOGO[brand];
  return (
    <span className="flex shrink-0 items-center justify-center overflow-hidden" style={{ width: size, height: size, borderRadius: radius, background: bare ? "transparent" : "#fff", padding: bare ? 0 : inset }}>
      <Mark src={logo.src} alt={logo.alt} fill={bare} />
    </span>
  );
}

function ChatIcon({ size }: { size: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M21 12a8 8 0 0 1-11.6 7.1L4 20l1-4.6A8 8 0 1 1 21 12z" />
    </svg>
  );
}
function BarsIcon({ size }: { size: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M5 20V10M12 20V4M19 20v-7" />
    </svg>
  );
}

const Box = ({ left, top, width, height, className = "", children }: { left: number; top: number; width?: number; height?: number; className?: string; children?: ReactNode }) => (
  <div className={className} style={{ position: "absolute", left: x(left), top: y(top), ...(width !== undefined && { width: x(width) }), ...(height !== undefined && { height: y(height) }) }}>
    {children}
  </div>
);

const Line = ({ kind, dir, left, top, size, delay }: { kind: "in" | "out"; dir: "h" | "dn" | "up"; left: number; top: number; size: number; delay?: number }) => (
  <div
    aria-hidden="true"
    className={`hf-line hf-${kind} ${dir === "h" ? "" : `hf-v hf-${dir}`}`}
    style={{ left: x(left), top: y(top), ...(dir === "h" ? { width: x(size) } : { height: y(size) }), ...(delay !== undefined && { animationDelay: `${delay}s` }) }}
  />
);

const cardStyle = { background: "rgba(255,255,255,0.06)", border: "1px solid rgba(255,255,255,0.16)" } as const;

function Hub({ size, logo }: { size: string; logo: string }) {
  return (
    <div className="hf-hub flex items-center justify-center" style={{ width: size, height: size, borderRadius: "27%", background: "rgba(255,255,255,0.08)", border: "1px solid rgba(255,255,255,0.28)", boxShadow: "inset 0 1px 0 rgba(255,255,255,0.3)" }}>
      <span style={{ width: logo, height: logo, display: "block" }}>
        <Mark src="/logos/serp-connect.webp" alt="SERP Connect" />
      </span>
    </div>
  );
}

export function HeroFlow() {
  return (
    <div role="group" aria-label="Your data sources feed SERP Connect, which feeds Claude or ChatGPT. Sample question and answer shown." className="glass-panel w-full overflow-hidden rounded-[28px]">
      {/* ── Tablet and desktop: the designed canvas, scaled ── */}
      <div className="hidden sm:block">
        <div className="relative mx-auto w-full max-w-[700px]" style={{ aspectRatio: `${W} / ${H}`, containerType: "inline-size", ["--tw" as string]: u(340) }}>
          <Box left={16} top={52} className="hf-label" ><span style={{ fontSize: u(14) }}>Your data</span></Box>
          <Box left={484} top={52} className="hf-label"><span style={{ fontSize: u(14) }}>Your AI</span></Box>

          {[131, 211, 291, 371].map((t, i) => (
            <Line key={t} kind="in" dir="h" left={216} top={t} size={36} delay={i * 0.05} />
          ))}
          <Line kind="in" dir="dn" left={251} top={131} size={121} />
          <Line kind="in" dir="up" left={251} top={252} size={121} />
          <Line kind="in" dir="h" left={252} top={251} size={38} />
          <Line kind="out" dir="h" left={410} top={251} size={38} />
          <Line kind="out" dir="up" left={447} top={195} size={57} />
          <Line kind="out" dir="dn" left={447} top={252} size={57} />
          <Line kind="out" dir="h" left={448} top={195} size={36} />
          <Line kind="out" dir="h" left={448} top={307} size={36} />

          {SOURCES.map((s, i) => (
            <Box key={s.name} left={16} top={100 + i * 80} width={200} height={64}>
              <div className="flex h-full w-full items-center" style={{ ...cardStyle, borderRadius: u(18), gap: u(12), padding: `0 ${u(12)}` }}>
                <Tile brand={s.brand} size={u(40)} radius={u(12)} inset={u(7)} />
                <span className="whitespace-nowrap font-semibold" style={{ fontSize: u(16) }}>{s.name}</span>
              </div>
            </Box>
          ))}

          <Box left={290} top={192} width={120} height={120}>
            <Hub size="100%" logo={u(68)} />
          </Box>
          <Box left={250} top={324} width={200}>
            <p className="accent text-center text-white" style={{ fontSize: u(26), lineHeight: 1.1 }}>SERP Connect</p>
          </Box>

          {AIS.map((a, i) => (
            <Box key={a.name} left={484} top={164 + i * 112} width={200} height={64}>
              <div className="hf-glow flex h-full w-full items-center" style={{ ...cardStyle, borderRadius: u(18), gap: u(12), padding: `0 ${u(12)}` }}>
                <Tile brand={a.brand} bare size={u(40)} radius={u(11)} inset="0" />
                <span className="whitespace-nowrap font-semibold" style={{ fontSize: u(16) }}>{a.name}</span>
              </div>
            </Box>
          ))}

          <Box left={16} top={428} width={668} height={48}>
            <div className="flex h-full w-full items-center" style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.16)", borderRadius: u(16), gap: u(12), padding: `0 ${u(18)}` }}>
              <span style={{ color: "#FF9A3D", display: "flex" }}><ChatIcon size={u(20)} /></span>
              <span className="font-medium text-white" style={{ fontSize: u(17) }}><span className="hf-typed">{QUESTION}</span></span>
            </div>
          </Box>
          <Box left={16} top={488} width={668} height={48}>
            <div className="hf-answer flex h-full w-full items-center" style={{ background: "rgba(0,128,128,0.3)", border: "1px solid rgba(94,214,203,0.55)", borderRadius: u(16), gap: u(12), padding: `0 ${u(18)}` }}>
              <span style={{ color: "#5ED6CB", display: "flex" }}><BarsIcon size={u(20)} /></span>
              <span className="min-w-0 flex-1 truncate font-semibold text-white" style={{ fontSize: u(17) }}>{ANSWER}</span>
              <span className="whitespace-nowrap" style={{ fontSize: u(14), color: "rgba(255,255,255,0.8)" }}>via Search Console</span>
            </div>
          </Box>
        </div>
      </div>

      {/* ── Phones: the same story, stacked ── */}
      <div className="p-4 sm:hidden" style={{ ["--tw" as string]: "21em" }}>
        <p className="hf-label text-xs">Your data</p>
        <ul className="mt-2 grid grid-cols-2 gap-2">
          {SOURCES.map((s) => (
            <li key={s.name} className="flex min-h-12 items-center gap-2.5 rounded-2xl px-2.5 py-2" style={cardStyle}>
              <Tile brand={s.brand} size="32px" radius="10px" inset="5px" />
              <span className="text-[0.8125rem] font-semibold leading-tight">{s.name}</span>
            </li>
          ))}
        </ul>

        <div className="relative mx-auto my-1 flex flex-col items-center">
          <span aria-hidden="true" className="hf-line hf-in hf-v hf-dn" style={{ position: "relative", height: 28 }} />
          <Hub size="84px" logo="58px" />
          <p className="accent mt-1 text-2xl text-white">SERP Connect</p>
          <span aria-hidden="true" className="hf-line hf-out hf-v hf-dn mt-1" style={{ position: "relative", height: 28 }} />
        </div>

        <p className="hf-label text-xs">Your AI</p>
        <ul className="mt-2 grid grid-cols-2 gap-2">
          {AIS.map((a) => (
            <li key={a.name} className="hf-glow flex min-h-12 items-center gap-2.5 rounded-2xl px-2.5 py-2" style={cardStyle}>
              <Tile brand={a.brand} bare size="32px" radius="10px" inset="0" />
              <span className="text-[0.9375rem] font-semibold">{a.name}</span>
            </li>
          ))}
        </ul>

        <div className="mt-4 flex items-center gap-2.5 rounded-2xl px-3.5 py-3" style={{ background: "rgba(255,255,255,0.07)", border: "1px solid rgba(255,255,255,0.16)" }}>
          <span style={{ color: "#FF9A3D", display: "flex" }}><ChatIcon size="18px" /></span>
          <span className="min-w-0 text-[0.9375rem] font-medium text-white"><span className="hf-typed">{QUESTION}</span></span>
        </div>
        <div className="hf-answer mt-2 flex items-center gap-2.5 rounded-2xl px-3.5 py-3" style={{ background: "rgba(0,128,128,0.3)", border: "1px solid rgba(94,214,203,0.55)" }}>
          <span style={{ color: "#5ED6CB", display: "flex" }}><BarsIcon size="18px" /></span>
          <span className="min-w-0 flex-1 text-[0.9375rem] font-semibold text-white">{ANSWER}</span>
        </div>
        <p className="muted mt-3 text-center text-xs">Sample question and answer · via Search Console</p>
      </div>
    </div>
  );
}
