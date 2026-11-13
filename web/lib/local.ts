/**
 * A copy of the wallet running on your own computer (README: "Run it fully local"): local.instantwallet.io,
 * localhost or 127.0.0.1. Our site never is one.
 */
export const isLocalHost = (host: string) => /^local\.|^localhost$|^127\.0\.0\.1$/.test(host);
export const isLocal = () => typeof window !== "undefined" && isLocalHost(window.location.hostname);
