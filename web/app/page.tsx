import { SafeRoot } from "@/components/safe/SafeRoot";

/** Instant Wallet on a Safe (docs/PLAN.md, docs/SAFE-APP.md). */
export default function Page() {
  return (
    <>
      {/* the wallet renders client-side; this gives search engines the words without JS */}
      <div className="sr-only">
        <h1>Instant Wallet: a passkey Ethereum wallet with no seed phrase</h1>
        <p>
          An Ethereum wallet in seconds that will last forever, by Austin Griffith. No seed phrase: Face ID or your fingerprint (a passkey) signs.
          Social recovery. Backed by Safe. It holds your coins on Ethereum, Base, Arbitrum and more, in your browser or the
          iPhone app. You can run it all on your own computer. A wedgie (DIY hardware wallet) guards the big money.
        </p>
        <h2>A smart wallet on a Safe</h2>
        <p>
          Your wallet is a Safe smart account with the same address on 14 networks. Your passkey is its first signer. Add a
          hardware signer or more people, and pick how many must sign. Every transaction is shown in plain words before you sign.
        </p>
        <ul>
          <li><a href="https://apps.apple.com/app/id6820719211">Instant Wallet for iPhone on the App Store</a></li>
          <li><a href="https://wedgie.dev">wedgie: the open-source DIY Ethereum hardware wallet</a></li>
          <li><a href="https://github.com/clawdbotatg/instant-wallet">Source on GitHub</a></li>
          <li><a href="/privacy">Privacy</a></li>
          <li><a href="/terms">Terms</a></li>
        </ul>
      </div>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SafeRoot />
    </>
  );
}

const AUSTIN = { "@type": "Person", "@id": "https://instantwallet.io/#austin", name: "Austin Griffith", sameAs: ["https://x.com/austingriffith", "https://github.com/austintgriffith"] };
const WORDS = "An Ethereum wallet in seconds that will last forever. No seed phrase: a passkey (Face ID or your fingerprint) signs. Social recovery. Backed by Safe.";
const jsonLd = {
  "@context": "https://schema.org",
  "@graph": [
    AUSTIN,
    { "@type": "WebSite", "@id": "https://instantwallet.io/#site", url: "https://instantwallet.io/", name: "Instant Wallet", alternateName: ["instantwallet.io", "Instant Wallet passkey wallet"], author: { "@id": AUSTIN["@id"] } },
    {
      "@type": "WebApplication",
      name: "Instant Wallet",
      url: "https://instantwallet.io/",
      applicationCategory: "FinanceApplication",
      operatingSystem: "Any (web browser)",
      description: WORDS,
      image: "https://instantwallet.io/og4.png",
      author: { "@id": AUSTIN["@id"] },
      sameAs: ["https://github.com/clawdbotatg/instant-wallet"],
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
    {
      "@type": "MobileApplication",
      name: "Instant Wallet",
      url: "https://apps.apple.com/app/id6820719211",
      applicationCategory: "FinanceApplication",
      operatingSystem: "iOS",
      description: WORDS,
      author: { "@id": AUSTIN["@id"] },
      offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
    },
  ],
};
