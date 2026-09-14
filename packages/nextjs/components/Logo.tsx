/** The wallet mark: a rounded wallet with a green flap and three green speed lines. */
export function LogoMark({ size = 28 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden>
      <path d="M16 14h26a6 6 0 0 1 6 6v4H16v-10Z" fill="#22c452" />
      <rect x="16" y="20" width="36" height="30" rx="9" stroke="#1a1b1a" strokeWidth="3.2" fill="#fff" />
      <rect x="9" y="27" width="10" height="4" rx="2" fill="#22c452" />
      <rect x="9" y="34" width="10" height="4" rx="2" fill="#22c452" />
      <rect x="9" y="41" width="10" height="4" rx="2" fill="#22c452" />
      <circle cx="42" cy="35" r="3.2" fill="#1a1b1a" />
    </svg>
  );
}

export function LogoLockup({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <LogoMark size={size} />
      <span className="font-bold text-[1.15rem] tracking-tight">Instant Wallet</span>
    </div>
  );
}

/** Big app-icon style tile for the welcome screen. */
export function LogoTile({ size = 200 }: { size?: number }) {
  return (
    <div
      className="rounded-[48px] bg-white flex items-center justify-center"
      style={{
        width: size,
        height: size,
        boxShadow: "0 24px 60px -18px rgb(0 0 0 / 0.18), 0 4px 14px rgb(0 0 0 / 0.05)",
      }}
    >
      <svg width={size * 0.62} height={size * 0.62} viewBox="0 0 64 64" fill="none" aria-hidden>
        <path d="M18 12h24a8 8 0 0 1 8 8v3H18v-11Z" fill="#22c452" />
        <rect x="18" y="19" width="34" height="32" rx="10" stroke="#d9d9d4" strokeWidth="3" fill="#fff" />
        <rect x="8" y="27" width="11" height="5" rx="2.5" fill="#22c452" />
        <rect x="8" y="35" width="11" height="5" rx="2.5" fill="#22c452" />
        <rect x="8" y="43" width="11" height="5" rx="2.5" fill="#22c452" />
        <circle cx="43" cy="35" r="3.5" fill="#6b6e6b" />
        <circle cx="43" cy="35" r="7" stroke="#d9d9d4" strokeWidth="3" />
      </svg>
    </div>
  );
}
