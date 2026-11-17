import type { Metadata } from "next";

/** The words under a link's preview card, and the card itself. One place, so instantwallet.io and xdai.io say the same. */
export const description =
  "Instant Wallet: an Ethereum wallet in seconds that will last forever. No seed phrase. Social recovery. Backed by Safe. It holds your coins on Ethereum, Base, Arbitrum and more, in your browser or the iPhone app. You can run it all on your own computer.";

/** Share cards need absolute image URLs: `site` is where this copy lives, `image` its 1200x630 card in /public. */
export const shareCard = (site: string, image: string): Pick<Metadata, "metadataBase" | "alternates" | "openGraph" | "twitter"> => ({
  metadataBase: new URL(site),
  alternates: { canonical: "/" },
  openGraph: { title: "Instant Wallet", description, url: "/", siteName: "Instant Wallet", images: [{ url: image, width: 1200, height: 630 }] },
  twitter: { card: "summary_large_image", title: "Instant Wallet", description, images: [image] },
});
