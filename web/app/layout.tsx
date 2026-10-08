import type { Metadata, Viewport } from "next";
import { DM_Mono, Outfit } from "next/font/google";
import "./globals.css";

// Outfit: the wordmark's look (og.png, design/gen.py)
const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit" });
const mono = DM_Mono({ subsets: ["latin"], weight: ["500"], variable: "--font-mono" });

const description =
  "Instant Wallet: an Ethereum smart wallet you make in seconds with Face ID or your fingerprint. No seed phrase, no app to install. Send, receive, and swap on Base; a wedgie (DIY hardware wallet) guards the big money.";

export const metadata: Metadata = {
  // share cards need absolute image URLs
  metadataBase: new URL("https://instantwallet.io"),
  title: "Instant Wallet — Ethereum wallet with Face ID, no seed phrase",
  description,
  keywords: ["Instant Wallet", "Ethereum wallet", "passkey wallet", "smart wallet", "Face ID wallet", "Base", "Safe", "crypto wallet"],
  alternates: { canonical: "/" },
  openGraph: { title: "Instant Wallet", description, url: "/", siteName: "Instant Wallet", images: [{ url: "/og.png", width: 1200, height: 630 }] },
  twitter: { card: "summary_large_image", title: "Instant Wallet", description, images: ["/og.png"] },
  appleWebApp: { capable: true, title: "Instant", statusBarStyle: "default" },
  icons: { icon: "/icons/icon-192.png", apple: "/icons/apple-touch-icon.png" },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#f4f4f1",
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
