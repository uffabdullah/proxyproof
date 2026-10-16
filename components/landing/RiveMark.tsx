"use client";

import { useRive } from "@rive-app/react-canvas";
import { Component, useState, type ReactNode } from "react";

function SignalFallback() {
  return (
    <svg viewBox="0 0 200 200" className="h-full w-full" aria-hidden>
      <circle cx="100" cy="100" r="18" fill="#ff4d3a" />
      <circle cx="100" cy="100" r="42" fill="none" stroke="#1a1410" strokeWidth="1.4" />
      <circle cx="100" cy="100" r="68" fill="none" stroke="#1a1410" strokeWidth="1.2" opacity="0.55" />
      <circle cx="100" cy="100" r="92" fill="none" stroke="#ff4d3a" strokeWidth="1.2" opacity="0.8" />
    </svg>
  );
}

function RiveCanvas() {
  const [failed, setFailed] = useState(false);
  const { rive, RiveComponent } = useRive({
    src: "/motion/signal.riv",
    autoplay: true,
    onLoadError: () => setFailed(true),
  });

  if (failed || !rive) return <SignalFallback />;
  return (
    <div className="h-full w-full">
      <RiveComponent />
    </div>
  );
}

class RiveBoundary extends Component<{ children: ReactNode }, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError() {
    return { failed: true };
  }

  render() {
    if (this.state.failed) return <SignalFallback />;
    return this.props.children;
  }
}

export default function RiveMark() {
  return (
    <RiveBoundary>
      <RiveCanvas />
    </RiveBoundary>
  );
}
