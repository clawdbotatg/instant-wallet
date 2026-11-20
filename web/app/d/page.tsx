import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { Drop } from "@/components/Drop";
import { fromLocalCopy } from "@/lib/local";

/** /d#CODE: claim from a drop (docs/DROPS.md). Not on a copy on your own computer: drops live in our site's store. */
export default async function Page() {
  if (fromLocalCopy({ headers: await headers() })) notFound();
  return <Drop />;
}
