import type { MetadataRoute } from "next";

export default function manifest(): MetadataRoute.Manifest {
  return {
    name: "Albay Flood Monitor | Model Rain & GIS Sources",
    short_name: "Flood Monitor",
    description:
      "Source-attributed weather-model rainfall, 3D terrain, administrative boundaries, and live road traffic across Albay Province.",
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
