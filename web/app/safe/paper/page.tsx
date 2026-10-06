/**
 * Printable paper-backup cards: a 24-word seed on 3 cards, any 2 rebuild it (OPSEK's seed-phrase sheet,
 * github.com/Opsek/seed-phrase-sheet). Card 1 = words 1–16, card 2 = words 9–24, card 3 = words 1–8 + 17–24.
 * Blank: you write the words by hand. This page never sees your seed.
 */
const CARDS: { name: string; words: number[] }[] = [
  { name: "Card A", words: Array.from({ length: 16 }, (_, i) => i + 1) },
  { name: "Card B", words: Array.from({ length: 16 }, (_, i) => i + 9) },
  { name: "Card C", words: [...Array.from({ length: 8 }, (_, i) => i + 1), ...Array.from({ length: 8 }, (_, i) => i + 17)] },
];

export default function Paper() {
  return (
    <div className="app paper">
      <h1>Paper backup</h1>
      <p className="fine">
        Your recovery seed, on 3 cards. Any 2 cards rebuild all 24 words; one card alone is 16 words, and the missing 8 can&apos;t be guessed.
      </p>
      <ol className="fine">
        <li>In MetaMask: add a new wallet (a fresh seed phrase). Use it only for this.</li>
        <li>Print this page. Write each word in its numbered box, in pen. Never type the seed anywhere else.</li>
        <li>Seal each card in its own tamper-evident bag. Write down each bag&apos;s serial number. Keep the 3 in 3 places.</li>
        <li>Copy the seed&apos;s address from MetaMask into Instant Wallet → Keys → Paper backup.</li>
        <li>Check a bag now and then: seal unbroken, serial matches. Broken seal = make a new seed and new cards.</li>
      </ol>
      {CARDS.map(c => (
        <div key={c.name} className="card seedcard">
          <div className="row" style={{ justifyContent: "space-between" }}>
            <b>Instant Wallet recovery · {c.name}</b>
            <span className="fine">bag serial ____________</span>
          </div>
          <div className="words">
            {c.words.map(n => (
              <div key={n} className="word">
                <span>{n}</span>
              </div>
            ))}
          </div>
          <p className="fine">Any 2 cards = the whole seed. Recovery waits 7 days and your keys can cancel it.</p>
        </div>
      ))}
      <p className="fine noprint center">Print with ⌘P / Ctrl+P.</p>
    </div>
  );
}
