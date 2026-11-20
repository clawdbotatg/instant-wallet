import type { Metadata, Viewport } from "next";
import { DM_Mono, Outfit } from "next/font/google";
import { NetBar } from "@/components/NetBar";
import { FundRelayHost } from "@/components/safe/FundRelayHost";
import { BRAND_SCRIPT } from "@/lib/brand";
import { description, shareCard } from "@/lib/share";
import "./globals.css";

// Outfit: the wordmark's look (og4.png)
const outfit = Outfit({ subsets: ["latin"], variable: "--font-outfit" });
const mono = DM_Mono({ subsets: ["latin"], weight: ["500"], variable: "--font-mono" });

export const metadata: Metadata = {
  ...shareCard("https://instantwallet.io", "/og4.png"),
  title: "Instant Wallet — an Ethereum wallet in seconds that will last forever",
  description,
  authors: [{ name: "Austin Griffith", url: "https://x.com/austingriffith" }],
  creator: "Austin Griffith",
  keywords: ["passkey Ethereum wallet", "Safe wallet", "Austin Griffith", "Instant Wallet", "Ethereum wallet", "passkey wallet", "smart wallet", "no seed phrase", "social recovery", "self-hosted wallet", "Base", "Safe", "crypto wallet"],
  // no `capable`: iOS opens the home-screen icon in Safari (same storage); see manifest.ts
  appleWebApp: { title: "Instant Wallet" },
  // Safari's Smart App Banner: "Open" / "Get" for the App Store app
  itunes: { appId: "6820719211" },
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
function show(){if(drawn()||document.getElementById("iw-crash"))return;var d=document.createElement("div");d.id="iw-crash";d.style.cssText="position:fixed;top:0;left:0;right:0;bottom:0;padding:24px;background:#121212;color:#eee;font:16px/1.4 -apple-system,sans-serif;overflow:auto;z-index:99999";d.style.textAlign="center";d.style.paddingTop="35vh";d.style.fontSize="20px";var ios=/iPhone|iPad|iPod/.test(navigator.userAgent),old=errs.some(function(m){return /SyntaxError|Unexpected token|Unexpected identifier|is not a function|Can't find variable/.test(m)});
var esc=function(t){return t.replace(/[<>&]/g,function(c){return {"<":"&lt;",">":"&gt;","&":"&amp;"}[c]})};
var btn="<p><button onclick=location.reload() style='font:inherit;font-size:18px;padding:10px 22px;border-radius:12px;border:0;background:#1fa045;color:#fff'>Reload</button></p>";
var why=errs.length?"<p style=font-size:12px;color:#777;text-align:left;word-break:break-all>"+esc(errs.slice(0,3).join(" \u00b7 "))+"<br>"+esc(navigator.userAgent)+"</p>":"";
d.innerHTML=(old?(ios?"<b>Update your iPhone to use the new version.</b><p style=font-size:17px;color:#aaa>Settings \u2192 General \u2192 Software Update</p>":"<b>Update your browser to use the new version.</b>"):errs.length?"<b>The app didn't load.</b>":"<b>Still loading\u2026</b><p style=font-size:17px;color:#aaa>Slow connection? Try again.</p>")+btn+why;document.body.appendChild(d)}
setTimeout(function(){if(errs.length)show()},6000);setTimeout(show,15000)})();`;

// Plausible: page visits only, no cookies. The URL it gets is the page's kind, never what's in it: no query or #,
// no address, no pay or claim link (/tx/… → /tx, a pay link → /link). The privacy page says so. A copy on your own
// computer (local.*, localhost) loads none of it: nothing to count, and plausible.io would see your IP.
const PLAUSIBLE_SCRIPT = `if(!/^local\\.|^localhost$|^127\\.0\\.0\\.1$/.test(location.hostname)){var ps=document.createElement("script");ps.async=true;ps.src="https://plausible.io/js/pa-GFtCLbOE4UoerqR3ISRki.js";document.head.appendChild(ps);
window.plausible=window.plausible||function(){(plausible.q=plausible.q||[]).push(arguments)},plausible.init=plausible.init||function(i){plausible.o=i||{}};
plausible.init({transformRequest:function(p){try{var u=new URL(p.u),s=u.pathname.split("/")[1]||"";
var known=["","claim","d","drops","join","paper","pk","pq","privacy","recover","terms","tx"];
p.u=u.origin+"/"+(known.indexOf(s)<0?"link":s==="claim"&&u.pathname.indexOf("/claim/new")===0?"claim/new":s)}catch(e){return null}return p}})}`;

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={`${outfit.variable} ${mono.variable}`} suppressHydrationWarning>
      <head>
        <script dangerouslySetInnerHTML={{ __html: CRASH_SCRIPT }} />
        <script dangerouslySetInnerHTML={{ __html: PLAUSIBLE_SCRIPT }} />
      </head>
      <body>
        {/* xdai.io's look, before first paint (lib/brand.ts) */}
        <script dangerouslySetInnerHTML={{ __html: BRAND_SCRIPT }} />
        <NetBar />
        {children}
        <FundRelayHost />
      </body>
    </html>
  );
}
