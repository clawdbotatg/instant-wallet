/** Settings → No external traffic (lib/noext.ts): the server's fetch refuses the outside while it's on. Local copy only. */
export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    if (!process.env.VERCEL) (await import("./lib/noext")).guard();
  }
}
