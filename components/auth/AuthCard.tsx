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
  const [code, setCode] = useState("");
  const [awaitingCode, setAwaitingCode] = useState(false);

  async function onSubmit(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const supabase = createClient();
    const cleanEmail = email.trim().toLowerCase();

    if (mode === "signup") {
      const taken = await supabase.rpc("email_taken", { p_email: cleanEmail });
      if (taken.error) {
        setPending(false);
        setError(taken.error.message);
        return;
      }
      if (taken.data) {
        setPending(false);
        setError("That email already has an account. Sign in, or reset the password.");
        return;
      }
      const { error: otpError } = await supabase.auth.signInWithOtp({
        email: cleanEmail,
        options: { shouldCreateUser: true, data: { full_name: fullName.trim(), role } },
      });
      setPending(false);
      if (otpError) {
        setError(otpError.message);
        return;
      }
      setAwaitingCode(true);
      return;
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

  async function confirmCode(event: FormEvent) {
    event.preventDefault();
    setError(null);
    setPending(true);
    const supabase = createClient();
    const cleanEmail = email.trim().toLowerCase();
    const { error: verifyError } = await supabase.auth.verifyOtp({
      email: cleanEmail,
      token: code.trim(),
      type: "email",
    });
    if (verifyError) {
      setPending(false);
      setError(verifyError.message);
      return;
    }
    const { error: passwordError } = await supabase.auth.updateUser({ password });
    setPending(false);
    if (passwordError) {
      setError(passwordError.message);
      return;
    }
    router.push(params.get("next") || "/room");
    router.refresh();
  }

  async function resendCode() {
    setError(null);
    const supabase = createClient();
    const { error: otpError } = await supabase.auth.signInWithOtp({
      email: email.trim().toLowerCase(),
      options: { shouldCreateUser: true, data: { full_name: fullName.trim(), role } },
    });
    setError(otpError ? otpError.message : "A new code is on its way.");
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

          {awaitingCode ? (
            <form onSubmit={confirmCode} className="mt-8 space-y-4">
              <p className="text-sm text-ink/70">
                Enter the 6-digit code sent to {email}. An address that does not exist will not receive it.
              </p>
              <label className="block">
                <span className="eyebrow text-ink/50">Email code</span>
                <input
                  className="field mt-2 tracking-[0.3em]"
                  inputMode="numeric"
                  autoComplete="one-time-code"
                  value={code}
                  onChange={(event) => setCode(event.target.value)}
                  required
                  minLength={6}
                  maxLength={8}
                />
              </label>
              {error && <p className="rounded-2xl bg-coral/10 px-4 py-3 text-sm">{error}</p>}
              <button className="btn btn-ink w-full" disabled={pending}>
                {pending ? "Checking the code…" : "Verify email"}
              </button>
              <button type="button" className="text-sm underline" onClick={resendCode}>
                Send the code again
              </button>
            </form>
          ) : (
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
              {pending ? "One moment…" : mode === "signup" ? "Send email code" : "Sign in"}
            </button>
          </form>
          )}

          <p className="mt-6 text-sm text-ink/70">
            {mode === "signup" ? (
              <>
                Already have an account? <Link href={params.get("next") ? `/login?next=${encodeURIComponent(params.get("next") || "")}` : "/login"} className="underline">Sign in</Link>
              </>
            ) : (
              <>
                New here? <Link href={params.get("next") ? `/signup?next=${encodeURIComponent(params.get("next") || "")}` : "/signup"} className="underline">Create an account</Link>
                <span className="mx-2">·</span>
                <Link href="/forgot" className="underline">Forgot password</Link>
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
