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
  satelliteRainfall: {
    name: "NASA GPM IMERG via GIBS",
    documentationUrl: "https://www.earthdata.nasa.gov/engage/open-data-services-software/earthdata-developer-portal/gibs-api",
    endpoint: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/IMERG_Precipitation_Rate",
    description:
      "Satellite-estimated surface precipitation rate from the Global Precipitation Measurement mission, published half-hourly with roughly 4 hours of latency"
  },
  satelliteFlood: {
    name: "NASA MODIS Flood Detection via GIBS",
    documentationUrl: "https://www.earthdata.nasa.gov/data/instruments/modis/near-real-time-data/mcdwd-nrt",
    endpoint: "https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/MODIS_Combined_Flood_3-Day",
    description:
      "Near-real-time surface water and flood detection (MCDWD) from the Terra and Aqua satellites, composited over the past 3 days at 250 m resolution"
  },
  elevation: {
    name: "NASA SRTM via Terrain Tiles on AWS Open Data",
    documentationUrl: "https://registry.opendata.aws/terrain-tiles/",
    endpoint: "https://s3.amazonaws.com/elevation-tiles-prod/terrarium",
    description:
      "Global elevation rasters derived primarily from the NASA Shuttle Radar Topography Mission, used to shade low-lying flood-susceptible ground"
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
