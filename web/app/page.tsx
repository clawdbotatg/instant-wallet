import { SafeApp } from "@/components/safe/SafeApp";

/** Instant Wallet on a Safe (docs/PLAN.md, docs/SAFE-APP.md). The old v3 wallet is at /v3. */
export default function Page() {
  return (
    <>
      {/* the wallet renders client-side; this gives search engines the words without JS */}
      <div className="sr-only">
        <h1>Instant Wallet</h1>
        <p>
          Make an Ethereum smart wallet in seconds with Face ID or your fingerprint (a passkey). No seed phrase, no app
          to install. Send, receive, and swap on Base. Built on Safe; a wedgie (DIY hardware wallet) guards the big money.
        </p>
      </div>
      <script type="application/ld+json" dangerouslySetInnerHTML={{ __html: JSON.stringify(jsonLd) }} />
      <SafeApp />
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
  description: "An Ethereum smart wallet you make in seconds with Face ID or your fingerprint. No seed phrase.",
  offers: { "@type": "Offer", price: "0", priceCurrency: "USD" },
};
