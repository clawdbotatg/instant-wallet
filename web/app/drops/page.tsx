import { headers } from "next/headers";
import { notFound } from "next/navigation";
import { DropAdmin } from "@/components/DropAdmin";
import { fromLocalCopy } from "@/lib/local";

/** Make and run drops (docs/DROPS.md). Not on a copy on your own computer: drops live in our site's store. */
export default async function Page() {
  if (fromLocalCopy({ headers: await headers() })) notFound();
  return <DropAdmin />;
}
