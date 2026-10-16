"use client";

import dynamic from "next/dynamic";
import Link from "next/link";
import { useEffect, useState } from "react";
import gsap from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";
import Lenis from "lenis";
import { createClient } from "@/lib/supabase/client";

const BeaconScene = dynamic(() => import("./BeaconScene"), { ssr: false });
const RiveMark = dynamic(() => import("./RiveMark"), { ssr: false });

function Heart() {
  return (
    <svg className="heart" viewBox="0 0 32 32" aria-hidden="true">
      <path
        d="M16 27.2C16 27.2 4.2 18.4 4.2 11.4 4.2 7.6 7 4.8 10.8 4.8c2.2 0 4 1.1 5.2 2.9 1.2-1.8 3-2.9 5.2-2.9 3.8 0 6.6 2.8 6.6 6.6 0 7-11.8 15.8-11.8 15.8z"
        fill="#ff4d3a"
        stroke="#1a1410"
        strokeWidth="1.1"
      />
    </svg>
  );
}

const ticker = [
  "Rotating tokens",
  "One device, one student",
  "Room-level presence",
  "No shared codes",
  "Live roster",
  "CSV for the organiser",
];

const chapters = [
  {
    n: "01",
    title: "The organiser’s phone becomes the beacon.",
    body: "Start a session for a fixed window, five minutes by default. While that screen stays open it broadcasts a token that changes every five seconds.",
  },
  {
    n: "02",
    title: "A student’s phone answers on its own.",
    body: "No code to type and nothing to photograph. The phone sends the live session, the fresh token, and the identity bound to that device.",
  },
  {
    n: "03",
    title: "The server is the only one allowed to say present.",
    body: "A mark lands only when the student is registered, the token is from this window, the request comes from their approved phone, and they are inside the room. Walk out and you have 30 seconds to return.",
  },
];

const requirements = [
  ["Two roles", "Organisers and students sign in separately. A student is bound to one phone. A different phone waits for an organiser."],
  ["A fixed clock", "A session broadcasts for the duration you set, then closes itself."],
  ["No typing", "Nearby students are marked while their page is open. They never enter a code."],
  ["Anti-proxy", "A forwarded code dies in seconds. One phone cannot mark two people."],
  ["A live roster", "Watch the room fill in, add or remove a name by hand, and close the session."],
  ["The record", "Students see history and a percentage. Organisers export a CSV."],
];

export default function Landing() {
  const [authed, setAuthed] = useState(false);

  useEffect(() => {
    const supabase = createClient();
    supabase.auth.getUser().then(({ data }) => setAuthed(Boolean(data.user)));
  }, []);

  useEffect(() => {
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduce) return;

    gsap.registerPlugin(ScrollTrigger);
    const lenis = new Lenis({ lerp: 0.075, wheelMultiplier: 0.9 });
    lenis.on("scroll", ScrollTrigger.update);
    const tick = (time: number) => lenis.raf(time * 1000);
    gsap.ticker.add(tick);
    gsap.ticker.lagSmoothing(0);

    const ctx = gsap.context(() => {
      gsap.from(".rise", {
        y: 32,
        duration: 1.15,
        stagger: 0.08,
        ease: "power4.out",
        clearProps: "transform",
      });
      gsap.to(".phone-drift", {
        y: -56,
        ease: "none",
        scrollTrigger: {
          trigger: ".hero",
          start: "top top",
          end: "bottom top",
          scrub: 1.4,
        },
      });
      gsap.utils.toArray<HTMLElement>(".chapter").forEach((el) => {
        gsap.from(el, {
          scrollTrigger: { trigger: el, start: "top 86%" },
          y: 36,
          duration: 1.05,
          ease: "power3.out",
          clearProps: "transform",
        });
      });
      gsap.from(".requirement", {
        scrollTrigger: { trigger: ".requirement-grid", start: "top 80%" },
        y: 28,
        duration: 0.9,
        stagger: 0.08,
        ease: "power3.out",
        clearProps: "transform",
      });
      gsap.from(".roster-copy, .roster-card", {
        scrollTrigger: { trigger: "#roster", start: "top 78%" },
        y: 40,
        duration: 1.1,
        stagger: 0.12,
        ease: "power3.out",
        clearProps: "transform",
      });
      gsap.from(".site-footer .footer-piece", {
        scrollTrigger: { trigger: ".site-footer", start: "top 90%" },
        y: 22,
        duration: 0.9,
        stagger: 0.08,
        ease: "power3.out",
        clearProps: "transform",
      });
    });

    return () => {
      ctx.revert();
      gsap.ticker.remove(tick);
      lenis.destroy();
      ScrollTrigger.getAll().forEach((trigger) => trigger.kill());
    };
  }, []);

  return (
    <div>
      <header className="mx-auto flex max-w-6xl items-center justify-between px-5 py-6">
        <Link href="/" className="text-lg font-semibold tracking-tight">
          ProxyProof
        </Link>
        <nav className="flex items-center gap-5 text-sm">
          <a href="#how" className="hidden sm:inline">
            How it works
          </a>
          <a href="#roster" className="hidden sm:inline">
            Roster
          </a>
          <Link href={authed ? "/room" : "/login"} className="btn btn-ink px-4 py-2 text-sm">
            {authed ? "Enter the room" : "Sign in"}
          </Link>
        </nav>
      </header>

      <main>
        <section className="hero mx-auto grid max-w-6xl items-center gap-10 px-5 pb-16 pt-6 lg:grid-cols-12 lg:pt-10">
          <div className="lg:col-span-7">
            <p className="rise eyebrow text-ink/60">Bluetooth attendance</p>
            <h1 className="rise serif mt-4 text-[clamp(3.4rem,8vw,7.2rem)] leading-[0.88] tracking-tight">
              Be in the room,
              <span className="italic"> or be absent.</span>
            </h1>
            <p className="rise mt-6 max-w-xl text-lg leading-relaxed text-ink/75">
              ProxyProof marks a student only when their own phone is beside a live class beacon.
              The token rotates every few seconds, the device belongs to one person, and a shared code does not count.
            </p>
            <div className="rise mt-8 flex flex-wrap gap-3">
              <Link href={authed ? "/room" : "/signup"} className="btn btn-ink">
                {authed ? "Open your room" : "Create an account"}
              </Link>
              <a href="#how" className="btn btn-ghost">
                See the three steps
              </a>
            </div>
          </div>

          <div className="relative lg:col-span-5">
            <div className="absolute inset-0 -z-10">
              <BeaconScene />
            </div>
            <div className="stage grid place-items-center py-6">
              <div className="phone-drift">
              <div className="phone">
                <div className="phone-screen px-5 pb-6 pt-12">
                  <div className="island" />
                  <p className="eyebrow text-ink/50">CS204 · Lecture 12</p>
                  <h2 className="serif mt-6 text-5xl leading-none">You&apos;re marked.</h2>
                  <p className="mt-3 text-sm text-ink/70">Present · this phone · just now</p>
                  <div className="mt-10 grid place-items-center">
                    <div className="h-36 w-36">
                      <RiveMark />
                    </div>
                  </div>
                  <div className="mt-8 rounded-3xl bg-ink px-4 py-4 text-foam">
                    <p className="text-xs uppercase tracking-[0.16em] text-foam/60">Beacon</p>
                    <p className="mt-1 text-lg">Token window is live</p>
                  </div>
                </div>
              </div>
              </div>
            </div>
          </div>
        </section>

        <div className="overflow-hidden border-y border-ink/10 py-4">
          <div className="marquee eyebrow">
            {[...ticker, ...ticker].map((item, index) => (
              <span key={`${item}-${index}`} className="flex items-center gap-10">
                {item}
                <span className="h-1.5 w-1.5 rounded-full bg-coral" />
              </span>
            ))}
          </div>
        </div>

        <section id="how" className="mx-auto max-w-6xl px-5 py-24">
          <p className="eyebrow text-ink/60">How it works</p>
          <div className="mt-10 divide-y divide-ink/10 border-y border-ink/10">
            {chapters.map((chapter) => (
              <article key={chapter.n} className="chapter grid gap-6 py-10 md:grid-cols-12">
                <p className="serif text-5xl text-coral md:col-span-2">{chapter.n}</p>
                <div className="md:col-span-10">
                  <h2 className="serif max-w-3xl text-4xl leading-[1.05] md:text-5xl">{chapter.title}</h2>
                  <p className="mt-4 max-w-2xl text-lg leading-relaxed text-ink/70">{chapter.body}</p>
                </div>
              </article>
            ))}
          </div>
        </section>

        <section className="mx-auto max-w-6xl px-5 pb-24">
          <div className="requirement-grid grid gap-4 md:grid-cols-2 lg:grid-cols-3">
            {requirements.map(([title, body], index) => (
              <article key={title} className="requirement panel p-6">
                <p className="eyebrow text-coral">0{index + 1}</p>
                <h3 className="serif mt-4 text-3xl">{title}</h3>
                <p className="mt-3 leading-relaxed text-ink/70">{body}</p>
              </article>
            ))}
          </div>
        </section>

        <section id="roster" className="mx-auto grid max-w-6xl gap-10 px-5 pb-28 lg:grid-cols-2">
          <div className="roster-copy">
            <p className="eyebrow text-ink/60">The live room</p>
            <h2 className="serif mt-4 text-5xl leading-[0.95] md:text-6xl">
              Names arrive while the beacon is on.
            </h2>
            <p className="mt-5 max-w-md text-lg leading-relaxed text-ink/70">
              Add someone the signal missed, take off a mark that should not be there, then export the hour as a CSV.
            </p>
          </div>
          <div className="roster-card panel overflow-hidden">
            <div className="flex items-center justify-between border-b border-ink/10 px-5 py-4">
              <div>
                <p className="eyebrow text-ink/50">Live · 4:12 left</p>
                <p className="mt-1 text-lg">Data structures</p>
              </div>
              <span className="rounded-full bg-moss px-3 py-1 text-sm text-foam">18 present</span>
            </div>
            {[
              ["Aisha Rahman", "STU-19AF", "auto", "just now"],
              ["Dev Kapoor", "STU-22C1", "auto", "12s ago"],
              ["Meera Iyer", "STU-08B4", "manual", "added"],
            ].map(([name, code, method, when]) => (
              <div key={code} className="flex items-center justify-between border-b border-ink/10 px-5 py-4 last:border-0">
                <div>
                  <p className="font-medium">{name}</p>
                  <p className="text-sm text-ink/50">{code}</p>
                </div>
                <div className="text-right text-sm">
                  <p className="capitalize">{method}</p>
                  <p className="text-ink/50">{when}</p>
                </div>
              </div>
            ))}
          </div>
        </section>
      </main>

      <footer className="site-footer border-t border-ink/10 px-5 py-16">
        <div className="mx-auto grid max-w-6xl gap-10 md:grid-cols-[1.4fr_1fr] md:items-end">
          <div className="footer-piece">
            <p className="serif text-4xl leading-tight md:text-5xl">
              Made with <span className="sr-only">love </span><Heart /> by
            </p>
            <p className="serif mt-3 text-4xl leading-none md:text-6xl">Abdullah Asger Ali</p>
            <p className="mt-4 max-w-md text-ink/70">
              First-year Computer Science and Engineering (Data Science) student.
            </p>
          </div>
          <div className="footer-piece flex flex-col items-start gap-4 md:items-end">
            <nav className="flex flex-wrap gap-x-5 gap-y-2 text-sm" aria-label="Abdullah Asger Ali">
              <a className="social" href="https://www.instagram.com/nvmitszipler/" target="_blank" rel="noreferrer">
                Instagram
              </a>
              <a className="social" href="https://github.com/uffabdullah" target="_blank" rel="noreferrer">
                GitHub
              </a>
              <a className="social" href="https://www.linkedin.com/in/abdullahasgerali/" target="_blank" rel="noreferrer">
                LinkedIn
              </a>
            </nav>
            <Link href="/signup" className="btn btn-ink">
              Start a class
            </Link>
          </div>
        </div>
      </footer>
    </div>
  );
}
