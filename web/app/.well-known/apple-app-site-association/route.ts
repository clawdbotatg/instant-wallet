// Names the iOS app (github.com/clawdbotatg/instant-wallet-app) to Apple: webcredentials lets its web view use
// this site's passkeys; applinks opens site links (claim cards, camera QR) in the app when it's installed.
const APP = "XX7QP5899Z.io.instantwallet";

export function GET() {
  return Response.json({
    webcredentials: { apps: [APP] },
    applinks: { details: [{ appIDs: [APP], components: [{ "/": "*" }] }] },
  });
}
