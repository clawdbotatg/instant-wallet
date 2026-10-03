import { App } from "@/components/App";

/** Payment links: /base:0xADDR;0.01 · /0xADDR · /ethereum:0x…@8453/transfer?… · /name.eth */
export default async function LinkPage({ params }: { params: Promise<{ link: string[] }> }) {
  const link = (await params).link.map(decodeURIComponent).join("/");
  return <App link={link} />;
}
