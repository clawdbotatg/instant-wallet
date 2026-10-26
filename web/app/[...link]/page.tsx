import { PayLink } from "@/components/PayLink";

/** A payment request link (/ethereum:…, a phone camera's scan of a Receive QR) and old v3 links (/base:0x…;0.01, /0x…, /name.eth). */
export default function LinkPage() {
  return <PayLink />;
}
