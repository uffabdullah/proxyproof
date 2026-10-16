import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "ProxyProof — Bluetooth Attendance",
    short_name: "ProxyProof",
    description: "Attendance that only counts when you are in the room.",
    start_url: "/room",
    display: "standalone",
    background_color: "#efe7dc",
    theme_color: "#1a1410",
    icons: [{ src: "/icon.svg", sizes: "any", type: "image/svg+xml" }],
  };
}
