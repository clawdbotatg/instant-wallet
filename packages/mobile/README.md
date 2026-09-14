# Instant Wallet — iOS shell

This folder becomes the App Store app. It is a Capacitor wrapper around the deployed web app;
the UI, the passkey logic, the device queue, the chat — all of it is `packages/nextjs`, served
from the URL in `capacitor.config.ts`. Nothing here is required to use Instant Wallet on a phone
today: open the URL in Safari and **Add to Home Screen**. This shell exists for the App Store,
native passkeys, and a smoother camera.

## Build (needs a Mac with Xcode 16+, CocoaPods, an Apple developer team)

```sh
cd packages/mobile
yarn install                 # capacitor cli + core + ios
mkdir -p www && echo '<meta http-equiv="refresh" content="0; url=https://instant-wallet-beta.vercel.app">' > www/index.html
yarn ios:add                 # creates ios/App (once)
yarn ios:sync
yarn ios:open                # Xcode: pick your team, run on your phone
```

For a phone on the same WiFi during development, point `INSTANT_WALLET_URL` at your laptop
(`http://192.168.x.x:3000`) and set `server.cleartext: true` temporarily.

## Passkeys inside the shell

WKWebView does not expose WebAuthn, so the page calls `window.InstantNativePasskey` when it runs
inside Capacitor (see the adapter at the top of `packages/nextjs/utils/passkey.ts`). Implement it
as a small Swift plugin around `ASAuthorizationPlatformPublicKeyCredentialProvider`:

- `create({rp, user, challenge})` → `{credentialId, publicKey (raw 65-byte P-256, base64url)}`
- `get({rpId, challenge, allowCredentials})` → `{credentialId, authenticatorData, clientDataJSON, signature}` (base64url)

For the passkeys to be **shared between Safari and the app** (same rpId, same credential), the
web origin must serve `/.well-known/apple-app-site-association` with the app's
`webcredentials` entry, and the Xcode project needs the Associated Domains capability
`webcredentials:instantwallet.io`. Until that is in place, the app and Safari each have their own
passkey; both can be added as signers of the same wallet, which the contract supports.

## Store review notes

Set `server.url` to the production domain, restrict `allowNavigation` to it, add the privacy
manifest, and describe the hardware device pairing in the review notes (the reviewer will not
have a device; the app is fully usable with a passkey alone).
