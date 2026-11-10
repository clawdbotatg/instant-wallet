/** Privacy policy (the App Store needs one). Plain words; keep it true when the app changes. */
export const metadata = { title: "Privacy · Instant Wallet" };

export default function Privacy() {
  return (
    <div className="app">
      <h1>Privacy</h1>
      <p className="fine">Last updated November 10, 2026.</p>
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
        <li>A transaction waiting for its other signers, with the signatures so far, for up to 30 days.</li>
        <li>
          If you turn on recovery alerts: the email, Telegram chat or device you chose, kept next to your wallet address
          until you turn them off.
        </li>
      </ul>
      <h3>What is public on the blockchain</h3>
      <ul className="fine">
        <li>Your wallet&apos;s address, what it holds and every transaction it makes. Anyone can see these, on any blockchain.</li>
        <li>
          That it is an Instant Wallet. Every Instant Wallet is made the same way and our relay sends its transactions,
          so anyone can list them from the chain.
        </li>
        <li>Not who you are. Nothing on chain has your name, unless you link one yourself (an ENS name, a purchase with ID).</li>
        <li>
          We read the chain ourselves to count totals: how many wallets, how much they hold together, how many
          transactions. We keep that list encrypted and private.
        </li>
      </ul>
      <h3>Other services</h3>
      <ul className="fine">
        <li>Blockchain data (balances, prices, swaps) comes from Alchemy, Uniswap and LI.FI; they see your wallet address.</li>
        <li>Buying or selling crypto goes through Coinbase or Ramp, under that company&apos;s own privacy policy.</li>
        <li>The camera is used only to scan QR codes, on your phone. Nothing is recorded or uploaded.</li>
        <li>
          The browser extension holds no keys. It keeps your address, connected sites and settings on your computer.
          It passes a site&apos;s requests to Instant Wallet in your browser, and its blockchain reads to our server.
        </li>
      </ul>
      <p className="fine">We don&apos;t sell or share your data. Questions: austin@ethereum.org</p>
    </div>
  );
}
