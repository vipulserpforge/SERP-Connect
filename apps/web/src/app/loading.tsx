export default function Loading() {
  return (
    <main className="container-x flex min-h-[50vh] items-center justify-center" aria-busy="true">
      <span className="spinner !h-8 !w-8" style={{ color: "var(--brand)" }} aria-hidden="true" />
      <p className="sr-only" role="status">
        Loading…
      </p>
    </main>
  );
}
