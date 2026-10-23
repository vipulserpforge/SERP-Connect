/**
 * SERP Connect logo: a vector mark plus real text, so it stays sharp at any size or pixel density and
 * uses the site's own font. `size` is the mark's height in px; the wordmark scales with it.
 */
export function Logo({ size = 36, tagline = false }: { size?: number; tagline?: boolean }) {
  return (
    <span className="inline-flex items-center" style={{ gap: size * 0.3 }}>
      <svg width={size} height={size} viewBox="0 0 40 40" role="img" aria-hidden="true" focusable="false">
        <rect x="13" y="2" width="25" height="25" rx="7" fill="#0FA3A3" />
        <rect x="2" y="13" width="25" height="25" rx="7" fill="#ABDCD6" />
        <rect x="13" y="13" width="14" height="14" rx="4" fill="#F8981D" />
      </svg>
      <span className="flex flex-col leading-none">
        <span className="font-semibold tracking-tight text-white" style={{ fontSize: size * 0.62 }}>
          SERP <span style={{ color: "#ABDCD6" }}>Connect</span>
        </span>
        {tagline && (
          <span className="muted" style={{ fontSize: Math.max(12, size * 0.32), marginTop: size * 0.12 }}>
            by SERP Forge
          </span>
        )}
      </span>
    </span>
  );
}
