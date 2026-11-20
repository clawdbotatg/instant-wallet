import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: "https://instantwallet.io/", changeFrequency: "weekly", priority: 1 },
    { url: "https://instantwallet.io/terms", changeFrequency: "monthly", priority: 0.2 },
    { url: "https://instantwallet.io/privacy", changeFrequency: "monthly", priority: 0.2 },
  ];
}
