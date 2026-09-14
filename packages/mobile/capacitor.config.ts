import type { CapacitorConfig } from "@capacitor/cli";

/**
 * The App Store shell. It is a thin native wrapper around the SAME web app that runs at the URL:
 * no second UI, no second codebase. What the shell adds over Safari:
 *   - native passkeys (ASAuthorizationController) exposed to the page as `window.InstantNativePasskey`
 *     (contract documented at the top of packages/nextjs/utils/passkey.ts)
 *   - the camera for the pairing QR without a permission prompt every time
 *   - an icon on the home screen and a place in the App Store
 *
 * `server.url` points at the deployed site, so the app updates when the site does. For a store
 * review build, set `server.url` to the production domain and pin `allowNavigation` to it.
 */
const config: CapacitorConfig = {
  appId: "io.instantwallet.app",
  appName: "Instant Wallet",
  webDir: "www", // unused while server.url is set; keep a placeholder index.html there
  server: {
    url: process.env.INSTANT_WALLET_URL || "https://instant-wallet-beta.vercel.app",
    cleartext: false,
    allowNavigation: ["*.vercel.app", "instantwallet.io", "*.instantwallet.io"],
  },
  ios: {
    contentInset: "automatic",
    backgroundColor: "#f4f4f1",
    scheme: "Instant Wallet",
  },
};

export default config;
