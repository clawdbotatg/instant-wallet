import type { MetadataRoute } from "next";

export default function sitemap(): MetadataRoute.Sitemap {
  return [
    { url: "https://instantwallet.io/", changeFrequency: "weekly", priority: 1 },
  ];
}
