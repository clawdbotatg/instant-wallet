/** Terms of service (ramps need one). Plain words; keep it true when the app changes. */
export const metadata = { title: "Terms · Instant Wallet" };

export default function Terms() {
  return (
    <div className="app">
      <h1>Terms</h1>
      <p className="fine">Last updated October 31, 2026.</p>
      <p>Instant Wallet is made by BuidlGuidl LLC (United States). By using it you agree to these terms.</p>
      <h3>Your wallet, your keys</h3>
      <p className="fine">
        Instant Wallet is self-custodial. Your keys stay on your devices; we never hold your money and can&apos;t move it,
        freeze it or get it back for you. If you lose every key that controls your wallet, the funds are gone.
      </p>
      <h3>Transactions</h3>
      <p className="fine">
        You approve every transaction yourself. Transactions on a blockchain are final. Check the address, amount and
        network before you sign.
      </p>
      <h3>Other services</h3>
      <p className="fine">
        Buying and selling crypto (Coinbase, Ramp), swaps (Uniswap, LI.FI) and apps you open in the wallet are
        run by other companies, under their own terms. They may ask for ID and may say no.
      </p>
      <h3>Rules</h3>
      <ul className="fine">
        <li>Don&apos;t use Instant Wallet to break the law, including sanctions.</li>
        <li>It isn&apos;t offered where it would be against the law to use it.</li>
      </ul>
      <h3>No warranty</h3>
      <p className="fine">
        Instant Wallet is free, open-source software provided as is, with no warranty. BuidlGuidl LLC isn&apos;t liable
        for any loss from using it, to the extent the law allows. We may change these terms; the date above shows the
        latest.
      </p>
      <p className="fine">Questions: austin@ethereum.org</p>
    </div>
  );
}
