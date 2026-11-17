import { SafeRoot } from "@/components/safe/SafeRoot";

/** Instant Wallet on a Safe (docs/PLAN.md, docs/SAFE-APP.md). */
export default function Page() {
  return (
    <>
      {/* the wallet renders client-side; this gives search engines the words without JS */}
      <div className="sr-only">
        <h1>Instant Wallet</h1>
        <p>
          An Ethereum wallet in seconds that will last forever. No seed phrase: Face ID or your fingerprint (a passkey) signs.
          Social recovery. Backed by Safe. It holds your coins on Ethereum, Base, Arbitrum and more, in your browser or the
          iPhone app. You can run it all on your own computer. A wedgie (DIY hardware wallet) guards the big money.
        </p>
      </div>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SafeRoot />
    </>
  );
}

const jsonLd = {
  "@context": "https://schema.org",
  "@type": "WebApplication",
  name: "Instant Wallet",
  url: "https://instantwallet.io/",
  applicationCategory: "FinanceApplication",
  operatingSystem: "Any (web browser)",
  description: "An Ethereum wallet in seconds that will last forever. No seed phrase. Social recovery. Backed by Safe.",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};
