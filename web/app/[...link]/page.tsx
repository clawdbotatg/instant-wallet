import { redirect } from "next/navigation";

/** Old v3 payment links (/base:0x…;0.01, /0x…, /name.eth): the Safe build doesn't read them yet, so open the wallet. */
export default function LinkPage() {
  redirect("/");
}
