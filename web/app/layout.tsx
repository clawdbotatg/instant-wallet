import type { Metadata, Viewport } from "next";
import { DM_Mono, Outfit } from "next/font/google";
import { BRAND_SCRIPT } from "@/lib/brand";
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
  // no `capable`: iOS opens the home-screen icon in Safari (same storage); see manifest.ts
  appleWebApp: { title: "Instant Wallet" },
  icons: {
    icon: [
      { url: "/icons/favicon-32.png", sizes: "32x32", type: "image/png" },
      { url: "/icons/icon-192.png", sizes: "192x192", type: "image/png" },
    ],
    apple: { url: "/icons/apple-touch-icon.png", sizes: "180x180" },
  },
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  maximumScale: 1,
  viewportFit: "cover",
  themeColor: "#f4f4f1",
};

// If the app never draws (an old browser it can't run on), say so on screen with the error and the browser, instead of
// a blank page. Plain ES5 in <head>, ahead of Next's own scripts, so it catches their errors too.
const CRASH_SCRIPT = `(function(){var errs=[];function rec(m){errs.push(String(m).slice(0,300))}
addEventListener("error",function(e){var t=e.target;rec(t&&t.src?"failed to load "+t.src:e.message+(e.filename?" @ "+e.filename.split("/").pop()+":"+e.lineno+":"+e.colno:""))},true);
addEventListener("unhandledrejection",function(e){var r=e.reason;rec("promise: "+(r&&r.message||r))});
function drawn(){var b=document.body;if(!b)return false;if(b.querySelector("svg,img,canvas,input,button"))return true;var t=b.innerText||"",s=b.querySelector(".sr-only");if(s)t=t.replace(s.innerText||"","");return t.trim().length>0}
function show(){if(drawn()||document.getElementById("iw-crash"))return;var d=document.createElement("div");d.id="iw-crash";d.style.cssText="position:fixed;top:0;left:0;right:0;bottom:0;padding:24px;background:#121212;color:#eee;font:16px/1.4 -apple-system,sans-serif;overflow:auto;z-index:99999";d.style.textAlign="center";d.style.paddingTop="35vh";d.style.fontSize="20px";d.textContent="This phone is too old to run the new version.";document.body.appendChild(d)}
setTimeout(function(){if(errs.length)show()},6000);setTimeout(show,15000)})();`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: CRASH_SCRIPT }} />
      </head>
      <body>
        {/* xdai.io's look, before first paint (lib/brand.ts) */}
        <script dangerouslySetInnerHTML={{ __html: BRAND_SCRIPT }} />
        {children}
      </body>
    </html>
  );
}
