# ProxyProof

Live site: https://proxyproof-cyan.vercel.app

Android install: https://github.com/uffabdullah/proxyproof/releases/latest

Attendance that counts only when a student is physically in the room.

An organiser starts a session on their phone. While that screen stays open it broadcasts a token that rotates every five seconds. A student’s phone, already bound to their name, sends the session, the fresh token, and a presence check. The server marks them only if the token is current, the phone is their approved device, and they are inside the room radius.

## What you can do

- Sign in as an organiser or a student.
- The first phone a student uses is bound automatically. A different phone waits for an organiser to approve it.
- Start a 5, 10, or 15 minute session. Keep the beacon page open.
- Students who leave their room page open are marked with no code to type.
- Watch the roster update, add or remove a name, and close the session.
- Students see history and a percentage. Organisers export CSV.

## Local setup

```bash
npm install
npm run dev
```

Copy `.env.example` to `.env.local` and add the Supabase URL and anon key. The database schema lives in `supabase/migrations/001_init.sql`.

Open two browsers (or a normal window and a private window). Create an organiser in one and a student in the other. Start a session, allow location on both phones, and leave both pages open.

## Stack

Next.js on Vercel, Supabase for accounts and data, Three.js for the beacon, GSAP and Lenis for the landing scroll, and Rive for the signal mark when `public/motion/signal.riv` is present.
