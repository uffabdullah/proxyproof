import Link from "next/link";

export default function NotFound() {
  return (
    <main className="grid min-h-screen place-items-center px-6 text-center">
      <div>
        <p className="eyebrow text-ink/60">404</p>
        <h1 className="serif mt-3 text-6xl">This page left the room.</h1>
        <Link href="/" className="btn btn-ink mt-8">
          Back to ProxyProof
        </Link>
      </div>
    </main>
  );
}
