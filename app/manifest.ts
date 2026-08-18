import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Albay Flood Monitor | Live Rain & GIS Intelligence",
    short_name: "Flood Monitor",
    description:
      "Near-real-time rainfall, flood-risk estimates, 3D terrain, and waterways across Albay Province.",
    start_url: "/",
    display: "standalone",
    background_color: "#eef0ed",
    theme_color: "#0E3550",
    icons: [
      {
        src: "/logo.svg",
        sizes: "any",
        type: "image/svg+xml"
      }
    ]
  };
}
