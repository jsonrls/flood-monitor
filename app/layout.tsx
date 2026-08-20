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
    default: "Albay Flood Monitor | Model Rain & GIS Sources",
    template: "%s | Flood Monitor"
  },
  description:
    "Explore traceable weather-model rainfall, 3D terrain, verified administrative boundaries, and live road traffic across Albay Province.",
  keywords: [
    "flood monitor",
    "Albay flood map",
    "Legazpi flood map",
    "Albay rainfall model",
    "rainfall map",
    "weather model",
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
    title: "Albay Flood Monitor | Model Rain & GIS Sources",
    description:
      "Explore source-attributed weather-model rainfall, 3D terrain, administrative boundaries, and live road traffic across Albay Province."
  },
  twitter: {
    card: "summary_large_image",
    title: "Albay Flood Monitor | Model Rain & GIS Sources",
    description:
      "Explore source-attributed weather-model rainfall, 3D terrain, administrative boundaries, and live road traffic across Albay Province."
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
