"use client";

import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { FormEvent, Suspense, useState } from "react";
import { createClient } from "@/lib/supabase/client";
import type { Role } from "@/lib/types";

function AuthForm({ mode }: { mode: "login" | "signup" }) {
  const router = useRouter();
  const params = useSearchParams();
  const [fullName, setFullName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [role, setRole] = useState<Role>("student");
  const [show, setShow] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const supabase = createClient();
    const cleanEmail = email.trim().toLowerCase();

    if (mode === "signup") {
      const { data, error: signError } = await supabase.auth.signUp({
        email: cleanEmail,
        password,
        options: {
          data: { full_name: fullName.trim(), role },
        },
      });
      if (signError) {
        setPending(false);
        setError(signError.message);
        return;
      }
      if (!data.session) {
        const second = await supabase.auth.signInWithPassword({ email: cleanEmail, password });
        if (second.error) {
          setPending(false);
          setError(second.error.message);
          return;
        }
      }
    } else {
      const { error: signError } = await supabase.auth.signInWithPassword({
        email: cleanEmail,
        password,
      });
      if (signError) {
        setPending(false);
        setError(
          signError.message === "Invalid login credentials"
            ? "That email and password don't match."
            : signError.message,
        );
        return;
      }
    }

    router.push(params.get("next") || "/room");
    router.refresh();
  }

  return (
    <main className="grid min-h-screen lg:grid-cols-2">
      <section className="hidden flex-col justify-between bg-ink px-12 py-10 text-foam lg:flex">
        <Link href="/" className="text-lg font-semibold">
          ProxyProof
        </Link>
        <div>
          <p className="eyebrow text-foam/50">The rule</p>
          <h1 className="serif mt-4 text-6xl leading-[0.92]">
            A code can be forwarded. <span className="italic">A person in the room cannot.</span>
          </h1>
        </div>
        <p className="max-w-sm text-sm text-foam/60">
          Organisers broadcast. Students are marked from the phone already bound to their name.
        </p>
      </section>

      <section className="flex items-center px-5 py-10">
        <div className="mx-auto w-full max-w-md">
          <Link href="/" className="text-lg font-semibold lg:hidden">
            ProxyProof
          </Link>
          <p className="eyebrow mt-8 text-ink/50">{mode === "signup" ? "Create an account" : "Welcome back"}</p>
          <h2 className="serif mt-3 text-5xl">
            {mode === "signup" ? "Join the room." : "Sign in."}
          </h2>

          <form onSubmit={onSubmit} className="mt-8 space-y-4">
            {mode === "signup" && (
              <>
                <label className="block">
                  <span className="eyebrow text-ink/50">Full name</span>
                  <input
                    className="field mt-2"
                    value={fullName}
                    onChange={(event) => setFullName(event.target.value)}
                    required
                    maxLength={80}
                    autoComplete="name"
                  />
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {(["student", "organiser"] as Role[]).map((option) => (
                    <button
                      key={option}
                      type="button"
                      aria-pressed={role === option}
                      onClick={() => setRole(option)}
                      className={`rounded-2xl border px-4 py-4 text-left capitalize ${
                        role === option ? "border-ink bg-ink text-foam" : "border-ink/15 bg-foam"
                      }`}
                    >
                      {option}
                    </button>
                  ))}
                </div>
              </>
            )}
            <label className="block">
              <span className="eyebrow text-ink/50">Email</span>
              <input
                className="field mt-2"
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                required
                autoComplete="email"
              />
            </label>
            <label className="block">
              <span className="flex items-center justify-between">
                <span className="eyebrow text-ink/50">Password</span>
                <button type="button" className="text-xs text-ink/60" onClick={() => setShow((value) => !value)}>
                  {show ? "Hide" : "Show"}
                </button>
              </span>
              <input
                className="field mt-2"
                type={show ? "text" : "password"}
                value={password}
                onChange={(event) => setPassword(event.target.value)}
                required
                minLength={6}
                autoComplete={mode === "signup" ? "new-password" : "current-password"}
              />
            </label>
            {error && <p className="rounded-2xl bg-coral/10 px-4 py-3 text-sm">{error}</p>}
            <button className="btn btn-ink w-full" disabled={pending}>
              {pending ? "One moment…" : mode === "signup" ? "Create account" : "Sign in"}
            </button>
          </form>

          <p className="mt-6 text-sm text-ink/70">
            {mode === "signup" ? (
              <>
                Already have an account? <Link href="/login" className="underline">Sign in</Link>
              </>
            ) : (
              <>
                New here? <Link href="/signup" className="underline">Create an account</Link>
              </>
            )}
          </p>
        </div>
      </section>
    </main>
  );
}

export default function AuthCard({ mode }: { mode: "login" | "signup" }) {
  return (
    <Suspense>
      <AuthForm mode={mode} />
    </Suspense>
  );
}
