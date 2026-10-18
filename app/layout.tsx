import type { Metadata, Viewport } from "next";
import { Instrument_Serif, Outfit } from "next/font/google";
import AppChrome from "@/components/AppChrome";
import AppPermissions from "@/components/AppPermissions";
import Cursor from "@/components/Cursor";
import "./globals.css";

const outfit = Outfit({
  subsets: ["latin"],
  variable: "--font-outfit",
});

const instrument = Instrument_Serif({
  weight: "400",
  style: ["normal", "italic"],
  subsets: ["latin"],
  variable: "--font-instrument",
});

export const metadata: Metadata = {
  title: "ProxyProof — Bluetooth Attendance",
  description:
    "Marks attendance when a student is physically in the room. Rotating tokens, one device per student, and a live roster.",
  applicationName: "ProxyProof",
  appleWebApp: {
    capable: true,
    title: "ProxyProof",
    statusBarStyle: "default",
  },
};

export const viewport: Viewport = {
  themeColor: "#efe7dc",
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  userScalable: false,
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${instrument.variable}`}>
      <body>
        <Cursor />
        <AppPermissions />
        <AppChrome />
        {children}
      </body>
    </html>
  );
}
