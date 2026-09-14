import { NextRequest, NextResponse } from "next/server";
import { expireStale, findRequest } from "~~/services/store";

export const dynamic = "force-dynamic";

/** Poll one request's status. */
export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  await expireStale();
  const request = await findRequest(id);
  if (!request) return NextResponse.json({ error: "unknown request" }, { status: 404 });
  return NextResponse.json({ request });
}
