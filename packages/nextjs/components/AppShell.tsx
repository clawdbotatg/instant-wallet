"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { ChatIcon, ClockIcon, CopyIcon, HomeIcon, KeyIcon, ReceiveIcon, SendIcon, SettingsIcon } from "./Icons";
import { LogoLockup } from "./Logo";
import { useWallet } from "./WalletProvider";
import { shortAddr } from "~~/utils/format";

const NAV = [
  { href: "", label: "Home", Icon: HomeIcon },
  { href: "/send", label: "Send", Icon: SendIcon },
  { href: "/receive", label: "Receive", Icon: ReceiveIcon },
  { href: "/activity", label: "Activity", Icon: ClockIcon },
  { href: "/keys", label: "Keys & limits", Icon: KeyIcon },
  { href: "/chat", label: "Talk to your wallet", Icon: ChatIcon },
];

export function Avatar({ seed, size = 40 }: { seed: string; size?: number }) {
  const h = parseInt(seed.slice(2, 8), 16) % 360;
  return (
    <div
      className="rounded-full flex-none"
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, hsl(${h} 70% 60%), hsl(${(h + 60) % 360} 70% 55%))`,
      }}
    />
  );
}

export function AppShell({ children }: { children: React.ReactNode }) {
  const { address } = useWallet();
  const pathname = usePathname();
  const base = `/w/${address}`;
  const isActive = (href: string) => (href === "" ? pathname === base : pathname.startsWith(base + href));

  return (
    <div className="min-h-dvh lg:flex">
      <aside className="hidden lg:flex fixed inset-y-0 left-0 w-[248px] flex-col border-r border-line bg-paper px-4 py-6">
        <Link href="/" className="px-2">
          <LogoLockup />
        </Link>
        <nav className="mt-8 flex flex-col gap-1">
          {NAV.map(({ href, label, Icon }) => (
            <Link key={label} href={base + href} className={`nav-item ${isActive(href) ? "active" : ""}`}>
              <Icon size={20} />
              {label}
            </Link>
          ))}
          <Link href="/settings" className={`nav-item ${pathname === "/settings" ? "active" : ""}`}>
            <SettingsIcon size={20} />
            Settings
          </Link>
        </nav>
        <div className="mt-auto">
          <AccountChip />
        </div>
      </aside>
      <main className="flex-1 lg:ml-[248px] pb-28 lg:pb-8">{children}</main>
      <MobileNav base={base} isActive={isActive} />
    </div>
  );
}

export function AccountChip() {
  const { address } = useWallet();
  return (
    <button
      className="card w-full flex items-center gap-3 p-3 text-left"
      onClick={() => navigator.clipboard?.writeText(address)}
      title="Copy address"
    >
      <Avatar seed={address} />
      <div className="min-w-0 flex-1">
        <div className="font-semibold text-sm truncate">My wallet</div>
        <div className="mono text-xs text-muted truncate">{shortAddr(address)}</div>
      </div>
      <CopyIcon size={18} className="text-muted" />
    </button>
  );
}

function MobileNav({ base, isActive }: { base: string; isActive: (h: string) => boolean }) {
  const items = NAV.slice(0, 4);
  return (
    <nav
      className="lg:hidden fixed bottom-3 inset-x-3 z-30 card px-2 py-2 flex justify-between"
      style={{ paddingBottom: "max(0.5rem, env(safe-area-inset-bottom))" }}
    >
      {items.map(({ href, label, Icon }) => {
        const active = isActive(href);
        return (
          <Link
            key={label}
            href={base + href}
            className={`flex flex-col items-center gap-1 rounded-2xl px-4 py-2 text-[11px] font-semibold ${active ? "bg-mint-soft text-mint-dark" : "text-muted"}`}
          >
            <Icon size={22} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}

/** Mobile page header: back chevron, centered title, optional right slot. Hidden on desktop by default. */
export function PageHeader({
  title,
  back,
  right,
  desktop = false,
}: {
  title: string;
  back?: string;
  right?: React.ReactNode;
  desktop?: boolean;
}) {
  return (
    <div className={`flex items-center justify-between px-5 pt-5 pb-3 ${desktop ? "" : "lg:hidden"}`}>
      {back ? (
        <Link
          href={back}
          className="w-11 h-11 rounded-full bg-white shadow-soft flex items-center justify-center"
          aria-label="Back"
        >
          <svg
            width="20"
            height="20"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="m14.5 6-6 6 6 6" />
          </svg>
        </Link>
      ) : (
        <div className="w-11" />
      )}
      <div className="font-bold text-[1.05rem]">{title}</div>
      <div className="w-11 flex justify-end">{right}</div>
    </div>
  );
}
