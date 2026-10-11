# Wedgie on the iPhone: open bugs (2026-10-11)

For checking before the next try. Each claim is marked **proven** (from a log line) or **guess**.

## Goal

The Instant Wallet iPhone app signs transactions on a wedgie over the WEDGIE USB drive (an iPhone can't use
the wedgie's USB serial port).

- Plug in, and it connects by itself in about 5 s. No taps.
- Small and big transactions both work. The only press is green on the wedgie.
- Unplug and replug works, and so do Forget and picking the drive again.
- A Mac or PC never sees the drive as writable, so it never shows an eject warning.

## How it works now

1. The person picks the WEDGIE folder once. The app keeps a bookmark to it.
2. The drive starts read-only. The app reads KNOCKB.TXT, KNOCKA.TXT, KNOCKB.TXT (uncached). The wedgie then
   turns writable, drops off USB for 2 s and comes back, so iOS mounts it writable.
3. To send, the page writes `REQ-<n>.TXT` (one JSON line). The wedgie answers in `ANSWER.TXT` (2048 bytes,
   served from its RAM). The page reads it uncached every 300 ms until its id shows up.
4. The first line of `ANSWER.TXT` is the wedgie's live state, refreshed every 0.5 s:
   `#count w<writes> a<ms since last write> ...`. The `a` value changes on every refresh. So if that line stays
   the same between two reads, the phone is not seeing the real drive.

Code:
- `instant-wallet-app/InstantWallet/Drive.swift` (the app)
- `web/lib/safe/wedgie.ts` (the page)
- `wedgie-dev/firmware/inbox.py` and `wedgiedrive.py` (the wedgie)

The phone log is `Documents/log.txt` in the app's container. To pull it:
`devicectl device copy from --domain-type appDataContainer --domain-identifier io.instantwallet --source Documents/log.txt`

## Bug 1: answers freeze after Forget and picking the drive again

### What happened (run on 0.3.43, 10-11, 4:35–4:39 PM)

| time | log | meaning |
|---|---|---|
| 4:36:51 | head `#8 w316 a2819` | last good read |
| 4:36:53 | forgot the drive | the picker opens |
| 4:37:12, 4:37:18 | picked iCloud by mistake | |
| 4:37:26 | picked WEDGIE, head `#8 w316 a8864` | already frozen |
| 4:37:26–4:38:21 | every read returns `#8 w316 a8864` | 7 hellos, no answers |
| 4:38:59 | head `#15 w603 a32460` | unfrozen; 7 answers there |

- **Proven:** both read methods returned the same frozen copy: NSFileCoordinator with `.uncached`, and POSIX
  `open` with `F_NOCACHE`.
- **Proven:** the frozen copy was read at about 4:36:57 (last write 4:36:48 plus `a8864` ms). That is after
  Forget and before the re-pick, while the picker was open. The app wasn't reading the drive then.
- **Proven:** the wedgie got the requests on time. The count went from 8 to 15 (all 7 answered), and at
  4:38:59 its last write was 32 s earlier (about 4:38:27). Only the phone's reads were stuck.
- **Proven:** the same thing happened on 0.3.42 at 2:28 (frozen `#1 w25 a9922`). Stalls lasted 2 to 5 minutes.
- **Proven, correcting what I said before:** the write counts are normal. iOS makes about 41 writes per
  request (24 to the FATs, 16 to the root folder, 1 data). The "205 writes" I flagged earlier were just
  5 requests.

### Why (guess)

The picker (a Files view) read `ANSWER.TXT` normally to show it or preview it, so iOS cached it. `F_NOCACHE`
only keeps new data out of the cache. A read of data already in the cache still gets the cached copy (Apple
forum, below). The wedgie changes the file's bytes but never its size or date, so iOS has no reason to drop
its copy until the cache ages it out.

Not proven:
- that the picker is what read it;
- that iOS hides FAT "hidden" files in the picker.

### Fix shipped: 0.3.44 hides ANSWER.TXT (untested)

Signed and pushed in wedgie-dev `c3e8221` / `2ef4f43`. The stall run above was still on 0.3.43, so this has
never been tested. If the guess is wrong, it does nothing.

### Proposed: let the app heal itself (not built)

Works whatever the cause turns out to be.

1. **Detect.** The app already reads the head line every 5 s. Read it every 1 s while writable. If it is
   identical twice in a row (the wedgie changes `a` every 0.5 s), the phone's view is stale.
2. **Heal.** Have the wedgie drop USB for 2 s and come back writable. A fresh mount has an empty cache.
   - **Proven:** every knock remount gave fresh reads.
   - Trigger it with a new request written as a file, `{"type":"remount"}`. During the stall, writes are
     proven to reach the wedgie; reads aren't.
   - Needs a firmware change: a remount request that drops USB and comes back still writable.
3. **Show it.** Put up a progress bar ("Reconnecting your wedgie", about 5 s). Retry the request after.

Cost: about 5 s, only when stuck. Worst case it remounts once for nothing.

## Bug 2: iOS refused the drive in the middle of a signature (0.3.44, 4:40 PM)

### What happened

| time | log |
|---|---|
| 4:39:54 | plugged in, read-only, knocking |
| 4:39:59 | writable, hello answered in 963 ms |
| 4:40:14–4:40:20 | hello and 4 pieces, each answered in about 1.3 s |
| 4:40:20 | `safe_sign` sent; the person presses yes through the screens |
| 4:40:25 | `iOS said no to the drive: pick it again`, then the page reports "drive away while waiting" |
| 4:40:42 | send failed: same error |
| after | nothing more in the log |

- **Proven:** `startAccessingSecurityScopedResource()` returned false. That is what the "iOS said no" error
  means.
- **Proven:** this is the first time in the whole log. Every earlier drop was "No valid file provider",
  which is what an unplug looks like.
- **Proven (from you):** the wedgie still showed the phone icon, so it was still writable and hadn't
  rebooted. Files still showed WEDGIE, so the drive was still mounted.
- **Proven, app bug:** after the first refusal the app logs nothing, because it only logs when the state
  changes. It never offers a way out, so it stays stuck while plugged in.
- Unknown: whether the wedgie signed. Its answer was never read.

### Why (guesses, none proven)

1. **The app opens and closes the drive's access too often.** Every file call opens and closes it, about 5
   times a second. Apple: leaking these uses up kernel resources, and then opening fails until the app
   relaunches. People report a limit of 1000–2500 (Apple forum 804886).
   - Against: our opens and closes look balanced, and earlier 20-minute runs never failed.
2. **The bookmark was made before the drive remounted.** It came from the 4:37:26 pick, and the knock
   remounted the drive at 4:39:57. Apple has a known bug where bookmarks don't resolve across volume mounts
   (r.102995804, forum 797469).
   - Against: it kept working for 26 s after that remount.

### Proposed fix (half written in Drive.swift, not committed, not built)

- **Keep one open access while the drive answers**, as Apple recommends. Drop it and reopen it after any
  failure. Done in `DriveIO.with` / `held`.
- **Make the bookmark again each time access opens**, so it always points at the current mount. Done in
  `with`.
- To do:
  - drop the held access on Forget and on a new pick (`io.release()`);
  - log every new error, not just state changes;
  - if refused for more than 5 s, open the panel at "Find my wedgie". iOS needs a tap to show the picker.

These are best practice whichever guess is right. None of them is proven to fix the refusal.

## Test plan for the next try

Before testing, check that the wedgie's `hello` in the log says the version under test. I skipped this
last time, and a whole test ran on the old firmware.

1. Plug in. **Pass:** "let in: writable" within about 5 s, no taps.
2. Big transaction (4 pieces plus sign). **Pass:** "answered safe_sig".
3. Forget, pick WEDGIE again, then a transaction right away. **Pass:** "answered hello" in about 1 s. Fail: the
   same head line repeating.
4. Do 3 twice more, and once with the picker left open for 30 s first.
5. Unplug, replug, transaction.
6. Keep the app open 10 minutes, then a transaction (looks for bug 2).
7. Mac: plug in 5 times and browse in Finder. **Pass:** never writable, no eject warning.

## My mistakes this round

- Shipped a fix before researching. Research came only after you asked.
- Called the 205 writes a problem. They were normal.
- Told you to test without first checking that the wedgie had the new firmware.

## Sources

- [F_NOCACHE doesn't skip data already cached (Apple forum 25464)](https://developer.apple.com/forums/thread/25464)
- [Leaked security scopes: access fails until relaunch (Apple forum 804886)](https://developer.apple.com/forums/thread/804886)
- [Bookmarks don't resolve across volume mounts, r.102995804 (Apple forum 797469)](https://developer.apple.com/forums/thread/797469)
- [A host keeps stale data unless the device signals a media change (TinyUSB discussion 1299)](https://github.com/hathach/tinyusb/discussions/1299)
- [USB mass storage and host caching](https://www.wasilzafar.com/pages/series/usb-dev/usb-dev-part08-mass-storage.html)
- [iOS external drives run in a user-space file system (MacStories)](https://www.macstories.net/stories/ios-and-ipados-13-the-macstories-review/7/)
