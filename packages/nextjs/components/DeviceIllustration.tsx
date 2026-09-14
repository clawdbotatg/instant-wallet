/**
 * The little Instant Wallet device: a white rounded body, a joystick nub on the left, a dark
 * 240x240 screen in the middle, four buttons on the right (green A on top, red Y at the bottom).
 */
export function DeviceIllustration({
  screen,
  width = 300,
  className = "",
  amount,
  to,
}: {
  screen: "sign" | "pair" | "addKey" | "home";
  width?: number;
  className?: string;
  /** What the little screen shows on "sign"; defaults are placeholders. */
  amount?: string;
  to?: string;
}) {
  return (
    <div className={`relative select-none ${className}`} style={{ width, aspectRatio: "300/150" }}>
      <div className="absolute inset-0 translate-x-1.5 translate-y-2 rounded-[22%/44%] bg-ink-2" />
      <div
        className="absolute inset-0 rounded-[22%/44%] bg-white flex items-center"
        style={{ boxShadow: "inset 0 -6px 0 #e9e9e4, 0 2px 4px rgb(0 0 0 / 0.08)" }}
      >
        <div className="ml-[7%] w-[13%] aspect-square rounded-full bg-[#5c5f5c] shadow-[inset_0_-3px_6px_rgb(0_0_0/0.35),0_0_0_5px_#ececea]" />
        <div className="ml-[6%] w-[34%] aspect-square rounded-[6px] bg-ink-2 overflow-hidden flex flex-col">
          {screen === "sign" && (
            <>
              <div className="bg-mint text-white text-[8px] font-extrabold tracking-widest text-center py-[3%]">
                SIGN
              </div>
              <div className="flex-1 flex flex-col items-center justify-center text-white">
                <div className="mono text-[13px] font-bold">{amount ?? "$2,000"}</div>
                <div className="text-[6px] tracking-wider text-mint mt-0.5 max-w-[90%] truncate">
                  TO {(to ?? "vault.atg.eth").toUpperCase()}
                </div>
              </div>
              <div className="bg-coral text-white text-[8px] font-extrabold tracking-widest text-center py-[3%]">
                REJECT
              </div>
            </>
          )}
          {screen === "pair" && (
            <div className="flex-1 flex flex-col items-center justify-center gap-1">
              <div
                className="w-[58%] aspect-square bg-white"
                style={{
                  backgroundImage:
                    "linear-gradient(90deg,#1a1b1a 50%,transparent 50%),linear-gradient(#1a1b1a 50%,transparent 50%)",
                  backgroundSize: "20% 20%",
                  backgroundBlendMode: "difference",
                }}
              />
              <div className="text-[6px] tracking-[0.2em] text-mint">SCAN TO PAIR</div>
            </div>
          )}
          {screen === "addKey" && (
            <>
              <div className="bg-mint text-white text-[8px] font-extrabold tracking-widest text-center py-[3%]">
                ADD KEY
              </div>
              <div className="flex-1 flex flex-col items-center justify-center text-white">
                <div className="text-[9px] font-bold">iPhone · Face ID</div>
                <div className="text-[6px] tracking-wider text-mint mt-0.5">LIMIT $500/DAY</div>
              </div>
              <div className="bg-coral text-white text-[8px] font-extrabold tracking-widest text-center py-[3%]">
                REJECT
              </div>
            </>
          )}
          {screen === "home" && (
            <div className="flex-1 flex flex-col justify-center px-2 text-white">
              <div className="text-[6px] text-[#9a9d9a]">BALANCE</div>
              <div className="mono text-[12px] font-bold">$2,847</div>
              <div className="text-[6px] text-mint">▲ +$14.02</div>
            </div>
          )}
        </div>
        <div className="ml-auto mr-[6%] flex flex-col gap-[6%] w-[9%]">
          <div className="aspect-[1/0.8] rounded-[4px] bg-mint shadow-[inset_0_-2px_0_rgb(0_0_0/0.25)]" />
          <div className="aspect-[1/0.8] rounded-[4px] bg-[#9a9c9a] shadow-[inset_0_-2px_0_rgb(0_0_0/0.25)]" />
          <div className="aspect-[1/0.8] rounded-[4px] bg-[#9a9c9a] shadow-[inset_0_-2px_0_rgb(0_0_0/0.25)]" />
          <div className="aspect-[1/0.8] rounded-[4px] bg-coral shadow-[inset_0_-2px_0_rgb(0_0_0/0.25)]" />
        </div>
      </div>
    </div>
  );
}
