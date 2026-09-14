import { NextRequest, NextResponse } from "next/server";
import { findRequest, patchRequest } from "~~/services/store";

export const dynamic = "force-dynamic";

/** Red button on the device (or Cancel in the browser). Frees the nonce slot right away. */
export async function POST(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const request = await findRequest(id);
  if (!request) return NextResponse.json({ error: "unknown request" }, { status: 404 });
  if (request.status !== "pending") {
    return NextResponse.json({ error: `request is ${request.status}`, status: request.status }, { status: 409 });
  }
  const body = await req.json().catch(() => ({}));
  const by = typeof body.by === "string" ? body.by.slice(0, 64) : "device";
  // The device sends `error` when it refused the request itself (digest / chain / wallet / matchCode mismatch).
  const error =
    typeof body.error === "string" && body.error.trim()
      ? `${body.error.trim().slice(0, 200)} (${by})`
      : `rejected on ${by}`;
  const done = await patchRequest(id, { status: "rejected", error });
  return NextResponse.json({ status: done.status, request: done });
}
