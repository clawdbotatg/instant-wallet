/** Privacy policy (the App Store needs one). Plain words; keep it true when the app changes. */
export const metadata = { title: "Privacy · Instant Wallet" };

export default function Privacy() {
  return (
    <div className="app">
      <h1>Privacy</h1>
      <p className="fine">Last updated October 8, 2026.</p>
      <p>Instant Wallet has no accounts, no email sign-up, no ads and no tracking.</p>
      <h3>What stays on your phone</h3>
      <p className="fine">
        Your keys. Face ID makes a passkey on your device (shared by your iCloud Keychain); we never see it. Wallet
        settings live in the app&apos;s local storage.
      </p>
      <h3>What our server sees</h3>
      <ul className="fine">
        <li>Transactions you send, so our relay can pay the gas and put them on chain. They are public on the blockchain anyway.</li>
        <li>Your wallet address and IP address, to limit abuse of the relay. Kept for at most a few days.</li>
        <li>A signed transaction you park for a hardware key (the wedgie hand-off), for up to 7 days.</li>
      </ul>
      <h3>Other services</h3>
      <ul className="fine">
        <li>Blockchain data (balances, prices, swaps) comes from Alchemy, Uniswap and LI.FI; they see your wallet address.</li>
        <li>Buying crypto with a card or Apple Pay goes through Coinbase, under Coinbase&apos;s own privacy policy.</li>
        <li>The camera is used only to scan QR codes, on your phone. Nothing is recorded or uploaded.</li>
      </ul>
      <p className="fine">We don&apos;t sell or share your data. Questions: austin@ethereum.org</p>
    </div>
  );
}
