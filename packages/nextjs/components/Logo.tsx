/* eslint-disable @next/next/no-img-element */
/**
 * Brand art (Austin's renders, 2026-09-13). Files in /public, cut from the sources in design/brand/ by
 * design/brand/make.py: mark.png (the wallet), mark-160.png (small), wordmark.png, logo.png (lockup),
 * device.png (the hardware signer). Each keeps its baked-in shadow, so no CSS shadows here.
 */
const MARK_RATIO = 782 / 671; // w / h
const DEVICE_RATIO = 961 / 711;

/** The wallet mark, sized by height. */
export function LogoMark({ size = 28, className = "" }: { size?: number; className?: string }) {
  return (
    <img
      src={size <= 80 ? "/mark-160.png" : "/mark.png"}
      alt=""
      aria-hidden
      height={size}
      width={Math.round(size * MARK_RATIO)}
      className={className}
      draggable={false}
    />
  );
}

export function LogoLockup({ size = 30, className = "" }: { size?: number; className?: string }) {
  return (
    <div className={`flex items-center gap-2 ${className}`}>
      <LogoMark size={size} />
      <span className="font-bold text-[1.15rem] tracking-tight">Instant Wallet</span>
    </div>
  );
}

/** Big mark for the welcome screen (the name is set in type below it). */
export function LogoTile({ size = 200 }: { size?: number }) {
  return (
    <img
      src="/mark.png"
      alt="Instant Wallet"
      width={size}
      height={Math.round(size / MARK_RATIO)}
      draggable={false}
      style={{ width: size, height: "auto" }}
    />
  );
}

/** The hardware signer render, for pairing and device screens. */
export function DeviceArt({ size = 240, className = "" }: { size?: number; className?: string }) {
  return (
    <img
      src="/device.png"
      alt="The Instant Wallet device"
      width={size}
      height={Math.round(size / DEVICE_RATIO)}
      className={className}
      draggable={false}
      style={{ width: size, height: "auto" }}
    />
  );
}
