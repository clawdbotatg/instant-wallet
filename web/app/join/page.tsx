import { Join } from "@/components/safe/Join";

/** /join#<id>: answer an invite to be a signer on someone's Instant Wallet (docs/MULTI-SIGNER.md). */
export default function Page() {
  return (
    <div className="app">
      <Join />
    </div>
  );
}
