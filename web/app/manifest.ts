import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Instant Wallet",
    short_name: "Instant",
    description: "Your money, instantly. Face ID makes the key; a wedgie guards the big money.",
    start_url: "/",
    scope: "/",
    // "browser", not "standalone": a home-screen icon opens in Safari/Chrome, so it shares their
    // localStorage (the saved wallet). Standalone gets its own storage on iOS — that's the PWA step.
    display: "browser",
    background_color: "#f4f4f1",
    theme_color: "#f4f4f1",
    icons: [
      { src: "/icons/icon-192.png", sizes: "192x192", type: "image/png", purpose: "any" },
      { src: "/icons/icon-512.png", sizes: "512x512", type: "image/png", purpose: "any" },
      { src: "/icons/maskable-192.png", sizes: "192x192", type: "image/png", purpose: "maskable" },
      { src: "/icons/maskable-512.png", sizes: "512x512", type: "image/png", purpose: "maskable" },
    ],
  };
}
