"use client";

export default function ErrorPage({ reset }: { error: Error & { digest?: string }; reset: () => void }) {
  // Never render error.message: server errors can contain internals.
  return (
    <main className="mx-auto max-w-xl px-5 py-28 text-center">
      <h1 className="text-4xl font-medium">
        Something <span className="accent">went wrong</span>
      </h1>
      <p className="muted mt-3">The error was logged. Please try again.</p>
      <button onClick={reset} className="btn-primary mt-8">
        Try again
      </button>
    </main>
  );
}
