import { NextResponse } from "next/server";

export const dynamic = "force-dynamic";

/** `GET /api/version` -> `{build}`: the commit live now. A page built from another one is stale (the iOS app's pull-down reloads it). */
export async function GET() {
  return NextResponse.json({ build: process.env.VERCEL_GIT_COMMIT_SHA ?? "dev" }, { headers: { "Cache-Control": "no-store" } });
}
