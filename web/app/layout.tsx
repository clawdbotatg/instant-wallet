import type { Metadata, Viewport } from "next";
import { DM_Mono, Nunito } from "next/font/google";
import "./globals.css";

const nunito = Nunito({ subsets: ["latin"], weight: ["500", "700", "800", "900"], variable: "--font-nunito" });
const mono = DM_Mono({ subsets: ["latin"], weight: ["500"], variable: "--font-mono" });

const description = "Your money, instantly. Face ID makes the key; a wedgie guards the big money.";

export const metadata: Metadata = {
  // share cards need absolute image URLs
  metadataBase: new URL("https://instantwallet.io"),
  title: "Instant Wallet",
  description,
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
    <html lang="en" className={`${nunito.variable} ${mono.variable}`}>
      <body>{children}</body>
    </html>
  );
}
