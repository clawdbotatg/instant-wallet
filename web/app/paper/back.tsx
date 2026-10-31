"use client";

/** Out of the paper page. The installed app has no browser back button, so this is the only way out. */
export function PaperBack() {
  const back = () => (history.length > 1 ? history.back() : location.assign("/"));
  return (
    <button className="btn wide noprint" onClick={back}>
      Back
    </button>
  );
}
