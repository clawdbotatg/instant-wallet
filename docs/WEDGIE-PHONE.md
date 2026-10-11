# A wedgie on an iPhone (USB-C): what we learned

Proven 2026-10-10 in the Wedgie iPhone app (`clawdbotatg/wedgie-dev`, `ios/WedgieDrive`) with wedgie
firmware 0.3.38: plug a wedgie into an iPhone, let the phone in, and wedgie.dev/safe signs Safe
transactions on it; Rainbow (RainbowKit) executes them. This is the guide for doing the same in the
Instant Wallet app (`instant-wallet-app`, a WKWebView on instantwallet.io).

## Why files, not serial

An iPhone can't open a wedgie's USB serial port: Safari has no Web Serial, and a native app needs Apple's
MFi program for it. But an iPhone mounts USB drives, and every wedgie is one (the WEDGIE drive). So the
phone talks to the wedgie through **files on that drive**:

- the app writes a request as a new file `REQ-<n>.TXT` (one JSON line, the same requests as over USB serial:
  wedgie-dev `public/skill.md`);
- the wedgie answers in `ANSWER.TXT`: first line `#<count>`, then its answers as JSON lines. Match yours by `id`.

Anything that moves money still needs the green button on the wedgie, exactly as over serial.

## The whole flow

1. **Pick the drive, once.** Apple's folder picker (`UIDocumentPickerViewController(forOpeningContentTypes:
   [.folder])`). Keep a security-scoped bookmark (`url.bookmarkData()`) in UserDefaults. It survives unplug
   and replug: never ask again.
2. **Knock.** The drive is read-only until then (below). The app knocks by itself (no tap, no question on
   firmware 0.3.41+); the wedgie drops off USB for 2 s and comes back writable.
3. **Send and read.** Write `REQ-<n>.TXT`, read `ANSWER.TXT` until an answer with your `id` is there
   (about 1-3 s; up to a minute while the wedgie waits for a press).

Writable lasts until unplug. Next plug-in: the bookmark still works, knock again.

## Read-only by default, and the knock (firmware 0.3.41+; wedgie.dev/skill.md is the reference)

- A writable drive made **every Mac** say "Disk Not Ejected Properly" at unplug. So the drive is read-only
  until something knocks.
- **The knock:** read the hidden `KNOCKB.TXT`, then `KNOCKA.TXT`, then `KNOCKB.TXT` again, uncached, each read
  0.3-3 s after the last (the app: 0.5 s). A repeat of the same file within 0.3 s counts as one read. Works any
  time, right after plug-in too. A scan (Mac mount, Windows Defender) reads A then B milliseconds apart, so it
  never knocks; a desktop never turns writable by itself, so no warning.
- **No question on the wedgie:** files can't do more than USB serial, which never asks. Signing still needs the
  green button.
- After the knock the wedgie turns the drive writable and **turns USB off for 2 s**, then on, so the phone
  remounts it writable; a phone shows in its corner until unplug. What didn't work: a SCSI media change (NOT
  READY, then UNIT ATTENTION) and a 0.4 s USB drop: the iPhone kept its read-only mount both times.
- Detect it in the app: `url.resourceValues(forKeys: [.volumeIsReadOnlyKey]).volumeIsReadOnly`.
- The app knocks every round (~2.5 s) until writable; extra knocks are ignored. It also reads `PHONE.TXT`
  each round for 0.3.37-0.3.40, which knocked by reading it twice 1-10 s apart (not in its first 8 s) and
  then asked "Allow phone txns?" (a no restarts it). One knock inside those 8 s did nothing: never knock just
  once.
- 0.3.41 also gives a request's RAM back as soon as it has read the file (an iPhone holds its deletes, so a big
  transaction's third piece once had no room). Pieces can go back to back.

## Apple's folder picker (the hard part of the UX)

- It's Apple's screen. We can't change it. It opens **wherever the person last was** (often iCloud Drive).
  The first time they must tap back, find **WEDGIE** under Locations, and tap **Open**. Show them a picture of
  that first: the picker's top bar, WEDGIE, and its blue Open with an arrow at it (`PickerHint` in
  `DrivePanel.swift`). Draw it as a small phone labeled "NEXT SCREEN": a plain bar with a blue Open looked
  like a button to tap right there (Austin). Say it in words too: "Tap Find my wedgie, go back to
  Locations, pick WEDGIE, tap Open. Only once."
- `directoryURL` starts the picker at a folder, but iOS only honors a URL it gave the app (a resolved
  bookmark). A plain path is ignored. So it helps only from the second pick on.
- People pick the wrong folder (iCloud). Check the pick: the WEDGIE drive has `README.txt` and `SKILL.md` at
  its top. If not: "That's not your wedgie", and don't keep the bookmark **or its path** (a wrong pick saved
  as the start folder sent every later picker to iCloud). Check on every poll too: a bookmark kept before
  the check existed that isn't the drive gets forgotten, and the person picks again.
- The drive mounted at
  `/private/var/mobile/Library/LiveFiles/com.apple.filesystems.userfsd/F5842556-5B7B-36D1-96CA-F5201A446FCD`
  on Austin's iPhone. The id is probably the FAT volume ID in drive.bin (the same on every wedgie), but that's
  seen on one phone only. Setting `directoryURL` to that path did nothing (tested): it opened iCloud.

## Reading and writing the drive (Swift)

- Every call: resolve the bookmark, `startAccessingSecurityScopedResource()`, do the work, stop. An unplug
  between calls is then just an error, never a stale handle. Poll once a second while the app is in front:
  iOS has no plug-in notification.
- **Read uncached**, or you get iOS's old copy: `NSFileCoordinator().coordinate(readingItemAt:options:
  .withoutChanges)` and `Data(contentsOf:options: .uncached)`. Proven: a new `ANSWER.TXT` is seen at once.
- **A new file name for every request** (`REQ-<n>.TXT`): the wedgie reads each file once. Delete old REQ
  files more than 5 s old before writing: the wedgie keeps what you write in RAM, 12 sectors (6 KB) at most.
- `ANSWER.TXT` is 2048 bytes and holds the last few answers; it starts over when full. Strip `\0` and
  padding newlines. Match by `id`.
- A Safe transaction too big for one line goes in pieces (`safe_data` then `safe_sign` with `data: "@"`,
  wedgie-safe). Works the same over files.
- The reference code: `ios/WedgieDrive/App/Drive.swift` (`DriveIO` actor, `Drive`: bookmark, poll,
  send, read, `readOnly`, `knock()`), `DrivePanel.swift` (the screens, `FolderPicker`, `PickerHint`,
  `WaitBar`), `WebView.swift` (the JS bridge).

## The page side (a web wallet in a WKWebView)

- The app injects `window.wedgieDrive` at document start, **only for its own host**:
  `status()` → `{state: "unpicked" | "away" | "readonly" | "here"}`, `send(line)` → the REQ file name,
  `read(name)` → text, `panel()` opens the native drive screen. (WKScriptMessageHandlerWithReply.)
- The page's transport (`wedgie-dev src/serial/drive.ts`): `request(obj, ms)` adds a unique `id`, sends,
  reads `ANSWER.TXT` every 700 ms until that id answers. One request at a time. It has the same shape as the
  serial `Repl.request`, so the rest of the page didn't change (`/safe`: `ask()` picks drive or serial).
  Instant Wallet: `web/lib/safe/wedgie.ts` is Web Serial only today. Add this as a second transport.
  Then test the serial path again: adding the drive to `/safe` left `ask()` calling itself for a serial
  wedgie ("Maximum call stack size exceeded" at "Reading its key", fixed in wedgie-dev 875322e).
- Poll `status()` every 0.5 s. "readonly" → the app is already knocking: show a bar ("Connecting your
  wedgie"), no button.

## WalletConnect / RainbowKit in a WKWebView (execute needs a wallet; the phone has none injected)

- RainbowKit (React + wagmi), loaded only when there's no `window.ethereum`. The page has no React otherwise.
  Wallets: Rainbow, MetaMask, Coinbase, WalletConnect (as in Scaffold-ETH).
- **The app must open wallet links itself**: `rainbow://`, `metamask://`, `wc:` etc. In
  `decidePolicyFor` and `createWebViewWith`, any non-http(s) scheme → `UIApplication.shared.open`.
- **The big one:** WalletConnect sends a request and opens the wallet **at the same moment**. On a phone the
  app then goes behind the wallet with the request half sent, and Rainbow sat 1-2 minutes before it could
  sign. Fix (`wedgie-dev src/safe/rainbow.ts lateLink`): move RainbowKit's `WALLETCONNECT_DEEPLINK_CHOICE` out of
  localStorage so WalletConnect can't open the wallet, listen for the sign client's `session_request_sent`,
  then open `<href>/wc?requestId=<id>&sessionTopic=<topic>` yourself. After that it was fast.
- Give WalletConnect its own `customStoragePrefix` if the page also runs WalletKit (wallet side).

## UX lessons from the test (Austin)

- **Never run a transaction by itself after a sign.** Signed and ready → a bar stuck to the bottom of the
  screen with **Execute**; the wallet opens only on that tap.
- **Show progress from the tap.** Say what's happening ("Getting your wallet", "Opening your wallet:
  confirm it there"), in that bottom bar only, not a second bar on the page. The bar creeps 1-2% every half
  second while it waits, and jumps ahead at each real step. Never looks stuck.
- After execute, keep reading the Safe and its queue until the nonce moved (the RPC and Safe's API lag
  seconds): the ran transaction leaves the queue without a Refresh.
- **Inputs at least 16px on a phone.** iOS zooms into a smaller field when it's tapped and stays zoomed,
  which pushed the bottom bar off screen.
- Narrow header: show only the address's picture, not the address text.
- The native drive screen matches the site: big title, one green pill, the log and test buttons behind
  "Details". After "Let this phone in", a creeping green bar until "Connected".
- Plain words, few of them, on every screen.

## Debugging on a real iPhone

- The Wedgie app also writes its log to `Documents/log.txt`. From the Mac:
  `xcrun devicectl device copy from --device <id> --domain-type appDataContainer --domain-identifier
  dev.wedgie.app --source Documents/log.txt --destination log.txt`
  (`DEVELOPER_DIR=/Applications/Xcode.app/Contents/Developer`).
- Build and install: `ios/WedgieDrive/README.md`. `-panel` as a launch argument opens on the drive screen
  (simulator screenshots).
- On a Mac, knock by reading `/Volumes/WEDGIE/KNOCKB.TXT`, `KNOCKA.TXT`, `KNOCKB.TXT` with `F_NOCACHE` (fcntl
  48), 0.5 s apart; `mount` then shows the drive without `read-only`. (Eject before unplugging, or the Mac warns.)
- The app's log has the page's side too: `page: hello <id>: answered hello in 963 ms` (window.wedgieDrive.log).

## Porting checklist for Instant Wallet

1. Copy `DriveIO` / `Drive` / `FolderPicker` / `PickerHint` / `WaitBar` / the drive screen into
   `instant-wallet-app`. Restyle to the wallet's look.
2. Inject `window.wedgieDrive` for instantwallet.io only.
3. Open non-http links (wallets) with `UIApplication.shared.open`.
4. In the site, add the drive transport to `web/lib/safe/wedgie.ts` beside Web Serial, picked when
   `window.wedgieDrive` exists.
5. The site already executes with its own relay/4337 path. If it uses WalletConnect anywhere on the phone,
   add the late deep link.
6. Test: plug in, pick the drive (first time: back, Locations, WEDGIE, Open), Let this phone in, green,
   then sign on the wedgie.

## Done in Instant Wallet (2026-10-10, updated 10-11)

- App (`instant-wallet-app`): `Drive.swift` (bookmark, poll every 0.5 s, ask, send/read; every drive call on
  its own thread with a 4 s limit, never at app start), `DrivePanel.swift` (find / plug in / press green /
  connected, picker hint: Browse, WEDGIE, Open), bridge `DriveBridge` in `WebView.swift`. While the panel is
  up and the drive is read-only, the app reads PHONE.TXT every 1.2 s until it's writable (no Ask again);
  `panel("connect")` closes the panel 0.9 s after it's writable. Every old REQ file is deleted before a write
  (the page sends one at a time), then a best-effort flush.
- Site: `web/lib/safe/wedgie.ts` picks the drive when `window.wedgieDrive` exists. `Wedgie.connect()` returns
  at once (so Face ID right after still has the tap); the first request opens the panel if the drive isn't
  writable and waits; closing the panel = "No wedgie connected". Over the drive: lines ≤ 1600 chars, big-tx
  pieces ≤ 1400 hex, 2.2 s between writes, 6 tries on a failed write. Installing the Safe signer stays
  computer-only. The wedgie sheet says "Connect wedgie"; a bar at the bottom shows sending and "press green".
- Firmware 0.3.39 asks "Allow phone txns". A phone send with the wedgie signs on the phone instead of
  parking for the computer. A 4-piece Safe tx went through on Austin's iPhone (10-11).
- Next: wedgie-dev `docs/PLAN-DRIVE-WRITE.md` (no question, a B-A-B read trigger, no 8 s wait).
