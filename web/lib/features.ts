"use client";

import { useEffect, useState } from "react";

/** What this server can run (app/api/features). Everything is on until it answers: our site has it all. */
export type Features = { deposit: boolean; alerts: boolean; names: boolean };
const ALL: Features = { deposit: true, alerts: true, names: true };
let asked: Promise<Features> | null = null;

export function useFeatures(): Features {
  const [f, setF] = useState(ALL);
  useEffect(() => {
    asked ??= fetch("/api/features")
      .then(r => r.json())
      .then(j => ({ ...ALL, ...j }))
      .catch(() => ALL);
    asked.then(setF);
  }, []);
  return f;
}
