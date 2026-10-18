"use client";

import Link from "next/link";
import { FormEvent, useState } from "react";
import { createClient } from "@/lib/supabase/client";

export default function ForgotPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [sent, setSent] = useState(false);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const supabase = createClient();
    const redirectTo = `${window.location.origin}/reset`;
    const { error: resetError } = await supabase.auth.resetPasswordForEmail(email.trim().toLowerCase(), { redirectTo });
    setPending(false);
    if (resetError) {
      setError(resetError.message);
      return;
    }
    setSent(true);
  }

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5">
      <Link href="/" className="text-lg font-semibold">ProxyProof</Link>
      <h1 className="serif mt-8 text-5xl">Reset password</h1>
      <p className="mt-3 text-ink/70">We will email a reset link to the address on the account.</p>
      {sent ? (
        <p className="mt-6 rounded-2xl bg-ink px-4 py-3 text-sm text-foam">
          If that email has an account, the reset link is on its way. Open it on this phone.
        </p>
      ) : (
        <form onSubmit={onSubmit} className="mt-6 space-y-4">
          <label className="block">
            <span className="eyebrow text-ink/50">Email</span>
            <input className="field mt-2" type="email" value={email} onChange={(event) => setEmail(event.target.value)} required autoComplete="email" />
          </label>
          {error && <p className="rounded-2xl bg-coral/10 px-4 py-3 text-sm">{error}</p>}
          <button className="btn btn-ink w-full" disabled={pending}>{pending ? "Sending…" : "Send reset email"}</button>
        </form>
      )}
      <Link href="/login" className="mt-6 text-sm underline">Back to sign in</Link>
    </main>
  );
}
