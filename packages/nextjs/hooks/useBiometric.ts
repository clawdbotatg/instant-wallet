"use client";

import { useEffect, useState } from "react";
import { biometricName } from "~~/utils/accounts";

/**
 * "Face ID" / "Touch ID" / "Windows Hello" for the confirm buttons. Starts with a fixed value so
 * server and client render the same HTML, then reads the user agent after hydration.
 */
export function useBiometric(): string {
  const [bio, setBio] = useState("Face ID");
  useEffect(() => setBio(biometricName()), []);
  return bio;
}
