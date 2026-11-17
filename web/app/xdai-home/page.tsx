import type { Metadata } from "next";
import { shareCard } from "@/lib/share";
import Page from "../page";

/** xdai.io's front page (next.config.ts sends xdai.io/ here): the same wallet, with xdai.io's own share card, the dark
 *  one. The look itself is still picked in the browser (lib/brand.ts). */
export const metadata: Metadata = shareCard("https://xdai.io", "/og-xdai.png");

export default Page;
