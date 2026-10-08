import type { MetadataRoute } from "next";

/** Index the home page; keep the API and pages that carry keys in the URL (claim links, recovery) out. */
export default function robots(): MetadataRoute.Robots {
  return {
    rules: { userAgent: "*", allow: "/", disallow: ["/api/", "/claim", "/pk", "/recover", "/guardian", "/paper", "/pq"] },
    sitemap: "https://instantwallet.io/sitemap.xml",
  };
}
