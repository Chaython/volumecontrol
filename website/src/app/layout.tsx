import type { Metadata } from "next";
import { GeistSans } from "geist/font/sans";
import { GeistMono } from "geist/font/mono";
import "./globals.css";
import { Toaster } from "@/components/ui/toaster";
import { asset } from "@/lib/asset-path";

const geistSans = GeistSans;
const geistMono = GeistMono;

export const metadata: Metadata = {
  title: "Volume Control — Live Preview",
  description:
    "A live, interactive preview of the Volume Control browser extension. Drop your own audio/video files and control them with the extension's real audio engine — ±32 dB boost, normalization, mono and per-site settings.",
  keywords: ["Volume Control", "browser extension", "volume boost", "WebAudio", "normalizer", "live preview"],
  authors: [{ name: "Chaython" }],
  icons: {
    icon: asset("/vc/ico.svg"),
  },
  openGraph: {
    title: "Volume Control — Live Preview",
    description:
      "Drop your own media into a mock browser and drive it with the extension's real WebAudio engine.",
    siteName: "Volume Control",
    type: "website",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${geistSans.variable} ${geistMono.variable} antialiased bg-background text-foreground`}
      >
        {children}
        <Toaster />
      </body>
    </html>
  );
}
