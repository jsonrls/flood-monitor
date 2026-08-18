export const VERIFIED_ALBAY_COVERAGE = {
  barangays: 720,
  cities: 3,
  municipalities: 15,
  localGovernmentUnits: 18,
  verifiedAsOf: "2026-06-30"
} as const;

export const DATA_SOURCES = {
  weather: {
    name: "Open-Meteo Forecast API",
    documentationUrl: "https://open-meteo.com/en/docs",
    endpoint: "https://api.open-meteo.com/v1/forecast",
    description: "Best-match numerical weather-model output from national weather services"
  },
  officialRainfall: {
    name: "DOST-PAGASA Automated Rain Gauges",
    endpoint: "https://bagong.pagasa.dost.gov.ph/automated-rain-gauge",
    description: "Station-specific hourly rain-gauge observations published by PAGASA"
  },
  administrativeNames: {
    name: "Philippine Statistics Authority PSGC",
    snapshot: "2023-10-24",
    currentCoverageReference: "2026-06-30",
    url: "https://psa.gov.ph/classification/psgc/citimuni/0500500000"
  },
  administrativeGeometry: {
    name: "NAMRIA-derived administrative boundaries",
    snapshot: "2023-11-06",
    release: "v2026.4.13.0",
    url: "https://github.com/bendlikeabamboo/barangay-boundaries-repository/releases/tag/v2026.4.13.0"
  },
  hydrology: {
    name: "OpenStreetMap contributors",
    overpassEndpoints: [
      "https://overpass-api.de/api/interpreter",
      "https://maps.mail.ru/osm/tools/overpass/api/interpreter",
      "https://overpass.private.coffee/api/interpreter"
    ],
    copyrightUrl: "https://www.openstreetmap.org/copyright",
    description: "Current volunteered OSM water features returned by documented global Overpass instances"
  },
  basemap: {
    name: "Mapbox Standard Satellite and Terrain DEM",
    documentationUrl: "https://docs.mapbox.com/mapbox-gl-js/guides/"
  },
  officialGuidance: {
    name: "PAGASA",
    url: "https://www.pagasa.dost.gov.ph/"
  }
} as const;
