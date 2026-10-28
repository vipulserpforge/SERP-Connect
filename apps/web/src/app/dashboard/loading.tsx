export default function Loading() {
  return (
    <main className="mx-auto max-w-6xl px-5 py-12" aria-busy="true">
      <div className="h-8 w-64 animate-pulse rounded-lg" style={{ background: "var(--line)" }} />
      <div className="mt-6 h-40 animate-pulse rounded-2xl" style={{ background: "var(--surface)" }} />
      <p className="sr-only" role="status">
        Loading your dashboard…
      </p>
    </main>
  );
}
