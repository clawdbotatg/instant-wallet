import type { SVGProps } from "react";

type P = SVGProps<SVGSVGElement> & { size?: number };
const base = (size: number, rest: P) => ({
  width: size,
  height: size,
  viewBox: "0 0 24 24",
  fill: "none",
  stroke: "currentColor",
  strokeWidth: 1.9,
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  ...rest,
});

export const FaceIdIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M4 16v2a2 2 0 0 0 2 2h2M16 20h2a2 2 0 0 0 2-2v-2" />
    <path d="M9 10v1M15 10v1M12 10v3.5a.5.5 0 0 1-.5.5H11" />
    <path d="M9.5 15.5c.7.7 1.5 1 2.5 1s1.8-.3 2.5-1" />
  </svg>
);

export const TouchIdIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="M7 7.5A6 6 0 0 1 18 11v2M5.5 11a7 7 0 0 1 .8-3.2M12 5a6 6 0 0 1 3.5 1.1" />
    <path d="M9 11a3 3 0 0 1 6 0v3.5M12 11v4a4 4 0 0 0 4 4M7.5 14a10 10 0 0 0 2 5.5M12 19.5c-.7-1-1-2.2-1-3.5" />
  </svg>
);

export const ChipIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <rect x="7" y="7" width="10" height="10" rx="2" />
    <rect x="10" y="10" width="4" height="4" rx="0.5" />
    <path d="M9 3v4M12 3v4M15 3v4M9 17v4M12 17v4M15 17v4M3 9h4M3 12h4M3 15h4M17 9h4M17 12h4M17 15h4" />
  </svg>
);

export const SendIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="M21 3 10.5 13.5M21 3l-7 18-3.5-7.5L3 10l18-7Z" />
  </svg>
);

export const ReceiveIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <rect x="4" y="4" width="6" height="6" rx="1.2" />
    <rect x="14" y="4" width="6" height="6" rx="1.2" />
    <rect x="4" y="14" width="6" height="6" rx="1.2" />
    <path d="M14 14h2v2h-2zM18 14h2v2h-2zM14 18h2v2h-2zM18 18h2v2h-2z" fill="currentColor" stroke="none" />
  </svg>
);

export const ScanIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="M4 8V6a2 2 0 0 1 2-2h2M16 4h2a2 2 0 0 1 2 2v2M4 16v2a2 2 0 0 0 2 2h2M16 20h2a2 2 0 0 0 2-2v-2M4 12h16" />
  </svg>
);

export const HomeIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="M3.5 10.5 12 4l8.5 6.5V19a1.5 1.5 0 0 1-1.5 1.5h-4.5V15h-5v5.5H5A1.5 1.5 0 0 1 3.5 19v-8.5Z" />
  </svg>
);

export const ClockIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <circle cx="12" cy="12" r="8.5" />
    <path d="M12 7.5V12l3 2" />
  </svg>
);

export const KeyIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <circle cx="8" cy="15" r="4" />
    <path d="m11 12 8.5-8.5M16 7l2.5 2.5M13.5 9.5 16 12" />
  </svg>
);

export const SettingsIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <circle cx="12" cy="12" r="3.5" />
    <path d="M12 3v2M12 19v2M3 12h2M19 12h2M5.6 5.6l1.4 1.4M17 17l1.4 1.4M5.6 18.4 7 17M17 7l1.4-1.4" />
  </svg>
);

export const BackIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="m14.5 6-6 6 6 6" />
  </svg>
);

export const ChevronIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="m9.5 6 6 6-6 6" />
  </svg>
);

export const PlusIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="M12 5v14M5 12h14" />
  </svg>
);

export const CopyIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <rect x="9" y="9" width="11" height="11" rx="2" />
    <path d="M5 15V6a2 2 0 0 1 2-2h9" />
  </svg>
);

export const CheckIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="m5 12.5 4.5 4.5L19 7.5" />
  </svg>
);

export const XIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="M6 6l12 12M18 6 6 18" />
  </svg>
);

export const ArrowUpRightIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="M7 17 17 7M8 7h9v9" />
  </svg>
);

export const ArrowDownLeftIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="M17 7 7 17M16 17H7V8" />
  </svg>
);

export const ArrowRightIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="M5 12h14M13 6l6 6-6 6" />
  </svg>
);

export const ShieldIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="M12 3.5 5 6v5.5c0 4.2 2.9 7.6 7 9 4.1-1.4 7-4.8 7-9V6l-7-2.5Z" />
    <path d="m9.5 12 1.8 1.8 3.5-3.6" />
  </svg>
);

export const WalletIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <rect x="3" y="6" width="18" height="13" rx="3" />
    <path d="M3 10h18M16 14h2" />
  </svg>
);

export const LockIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <rect x="5" y="10.5" width="14" height="10" rx="2.5" />
    <path d="M8 10.5V8a4 4 0 0 1 8 0v2.5" />
  </svg>
);

export const SparkIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="M12 3c.6 4 2.5 6.4 7 7-4.5.6-6.4 3-7 7-.6-4-2.5-6.4-7-7 4.5-.6 6.4-3 7-7Z" />
    <path d="M19 15c.2 1.5 1 2.3 2.5 2.5-1.5.2-2.3 1-2.5 2.5-.2-1.5-1-2.3-2.5-2.5 1.5-.2 2.3-1 2.5-2.5Z" />
  </svg>
);

export const ChatIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="M4 6.5A2.5 2.5 0 0 1 6.5 4h11A2.5 2.5 0 0 1 20 6.5v7a2.5 2.5 0 0 1-2.5 2.5H10l-4.5 3.5V16H6.5A2.5 2.5 0 0 1 4 13.5v-7Z" />
  </svg>
);

export const RefreshIcon = ({ size = 22, ...r }: P) => (
  <svg {...base(size, r)}>
    <path d="M20 12a8 8 0 1 1-2.3-5.7M20 4v5h-5" />
  </svg>
);

export const SunIcon = SettingsIcon;

/** Role/kind aware icon for a signer. */
export function SignerIcon({ kind, label, size = 22 }: { kind: number; label?: string; size?: number }) {
  if (kind === 1) return <ChipIcon size={size} />;
  if (label && /touch|mac/i.test(label)) return <TouchIdIcon size={size} />;
  return <FaceIdIcon size={size} />;
}
