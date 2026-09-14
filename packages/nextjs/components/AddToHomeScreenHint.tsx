"use client";

import { useEffect, useState } from "react";
import { XIcon } from "./Icons";

const KEY = "iw.a2hs.dismissed";

/** iOS Safari only, when not already installed: one line telling the user how to add the app. */
export function AddToHomeScreenHint() {
  const [show, setShow] = useState(false);
  useEffect(() => {
    try {
      if (localStorage.getItem(KEY)) return;
    } catch {
      return;
    }
    const ua = navigator.userAgent;
    const isIOS = /iPhone|iPad|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
    const isSafari = /Safari/.test(ua) && !/CriOS|FxiOS|EdgiOS|OPiOS/.test(ua);
    const standalone =
      (navigator as Navigator & { standalone?: boolean }).standalone === true ||
      window.matchMedia("(display-mode: standalone)").matches;
    setShow(isIOS && isSafari && !standalone);
  }, []);
  if (!show) return null;
  return (
    <div className="flex items-center gap-2 rounded-2xl bg-white shadow-soft px-4 py-2.5 text-[13px]">
      <ShareGlyph />
      <span className="flex-1">
        Tap <b>Share</b> then <b>Add to Home Screen</b> to install.
      </span>
      <button
        aria-label="Dismiss"
        className="text-muted"
        onClick={() => {
          try {
            localStorage.setItem(KEY, String(Date.now()));
          } catch {}
          setShow(false);
        }}
      >
        <XIcon size={16} />
      </button>
    </div>
  );
}

function ShareGlyph() {
  return (
    <svg
      width="18"
      height="18"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.9"
      strokeLinecap="round"
      strokeLinejoin="round"
      className="text-mint-dark flex-none"
    >
      <path d="M12 3v12M8 7l4-4 4 4" />
      <path d="M5 11v8a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-8" />
    </svg>
  );
}
