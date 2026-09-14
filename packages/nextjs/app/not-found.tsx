import Link from "next/link";

export default function NotFound() {
  return (
    <div className="min-h-dvh flex flex-col items-center justify-center gap-3 px-6 text-center">
      <div className="text-2xl font-bold">Nothing here</div>
      <Link href="/" className="btn btn-primary">
        Back to start
      </Link>
    </div>
  );
}
