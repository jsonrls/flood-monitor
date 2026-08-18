import type { Metadata, Viewport } from "next";
import "./globals.css";

const siteUrl =
  process.env.NEXT_PUBLIC_SITE_URL ||
  (process.env.VERCEL_PROJECT_PRODUCTION_URL
    ? `https://${process.env.VERCEL_PROJECT_PRODUCTION_URL}`
    : "http://localhost:3000");

export const metadata: Metadata = {
  metadataBase: new URL(siteUrl),
  applicationName: "Flood Monitor",
  title: {
    default: "Albay Flood Monitor | Live Rain & GIS Intelligence",
    template: "%s | Flood Monitor"
  },
  description:
    "Explore near-real-time rainfall, flood-risk estimates, 3D terrain, and waterways across every city, municipality, and barangay in Albay Province.",
  keywords: [
    "flood monitor",
    "Albay flood map",
    "Legazpi flood map",
    "Albay flood risk",
    "rainfall map",
    "flood risk",
    "GIS",
    "Mapbox",
    "weather map",
    "river map"
  ],
  alternates: {
    canonical: "/"
  },
  icons: {
    icon: [{ url: "/logo.svg", type: "image/svg+xml" }],
    shortcut: "/logo.svg"
  },
  openGraph: {
    type: "website",
    locale: "en_PH",
    url: "/",
    siteName: "Flood Monitor",
    title: "Albay Flood Monitor | Live Rain & GIS Intelligence",
    description:
      "Explore near-real-time rainfall, flood-risk estimates, 3D terrain, and waterways across Albay Province."
  },
  twitter: {
    card: "summary_large_image",
    title: "Albay Flood Monitor | Live Rain & GIS Intelligence",
    description:
      "Explore near-real-time rainfall, flood-risk estimates, 3D terrain, and waterways across Albay Province."
  },
  robots: {
    index: true,
    follow: true
  },
  category: "public service",
  formatDetection: {
    address: false,
    email: false,
    telephone: false
  }
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
  themeColor: "#0E3550",
  colorScheme: "light"
};

export default function RootLayout({
  children
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
