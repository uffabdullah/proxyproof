"use client";

import { useEffect, useRef } from "react";
import { playClick, unlockSound } from "@/lib/sound";

export default function Cursor() {
  const dot = useRef<HTMLDivElement>(null);
  const ring = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const fine = window.matchMedia("(hover: hover) and (pointer: fine)").matches;
    const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!fine) return;

    document.documentElement.classList.add("cursor-on");
    const point = { x: window.innerWidth / 2, y: window.innerHeight / 2 };
    const follow = { ...point };
    let frame = 0;
    let hovering = false;

    const onMove = (event: PointerEvent) => {
      point.x = event.clientX;
      point.y = event.clientY;
      const target = event.target instanceof Element ? event.target.closest("a, button") : null;
      hovering = Boolean(target);
      ring.current?.classList.toggle("is-hot", hovering);
    };

    const onDown = (event: PointerEvent) => {
      unlockSound();
      const target = event.target instanceof Element ? event.target.closest("a, button") : null;
      if (target) playClick();
      ring.current?.classList.add("is-down");
    };

    const onUp = () => ring.current?.classList.remove("is-down");

    const draw = () => {
      follow.x += (point.x - follow.x) * (reduce ? 1 : 0.18);
      follow.y += (point.y - follow.y) * (reduce ? 1 : 0.18);
      if (dot.current) dot.current.style.transform = `translate3d(${point.x}px, ${point.y}px, 0)`;
      if (ring.current) ring.current.style.transform = `translate3d(${follow.x}px, ${follow.y}px, 0)`;
      frame = requestAnimationFrame(draw);
    };

    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerdown", onDown);
    window.addEventListener("pointerup", onUp);
    frame = requestAnimationFrame(draw);

    return () => {
      document.documentElement.classList.remove("cursor-on");
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerdown", onDown);
      window.removeEventListener("pointerup", onUp);
      cancelAnimationFrame(frame);
    };
  }, []);

  return (
    <>
      <div ref={dot} className="cursor-dot" />
      <div ref={ring} className="cursor-ring" />
    </>
  );
}
