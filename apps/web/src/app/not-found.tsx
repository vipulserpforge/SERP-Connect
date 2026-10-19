import Link from "next/link";

export default function NotFound() {
  return (
    <main className="mx-auto max-w-xl px-5 py-28 text-center">
      <h1 className="text-4xl font-medium">
        Page <span className="accent">not found</span>
      </h1>
      <Link href="/" className="btn-primary mt-8">Back to home</Link>
    </main>
  );
}
