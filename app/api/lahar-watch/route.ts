import { PNG } from "pngjs";

// Mayon Volcano summit.
const MAYON_LAT = 13.2572;
const MAYON_LNG = 123.6856;
// Sampling window around the summit covering the main lahar channels (~±16 km).
const SAMPLE_RADIUS_DEG = 0.15;

const IMERG_ZOOM = 6;
const IMERG_TILE_SIZE = 256;
const CACHE_TTL_MS = 10 * 60 * 1000;

// Heuristic rain thresholds for rain-triggered lahar potential on Mayon's
// slopes. This is an unofficial indicator: PHIVOLCS bulletins are authoritative.
const HIGH_RATE_MM_PER_HOUR = 15;
const HIGH_3H_MM = 30;
const MODERATE_RATE_MM_PER_HOUR = 7.5;
const MODERATE_3H_MM = 15;

type LaharWatchPayload = {
  tier: "low" | "moderate" | "high";
  rateMmPerHour: number;
  accum3hMm: number;
  accum24hMm: number;
  satellite: {
    sampled: boolean;
    rainCoveragePercent: number | null;
  };
  computedAt: string;
  basis: string;
};

let cached: { expiresAt: number; payload: LaharWatchPayload } | null = null;

const roundTo = (value: number, decimals: number) => {
  const factor = 10 ** decimals;
  return Math.round(value * factor) / factor;
};

const fetchMayonRainfall = async () => {
  const params = new URLSearchParams({
    latitude: String(MAYON_LAT),
    longitude: String(MAYON_LNG),
    hourly: "precipitation",
    past_days: "1",
    forecast_days: "1",
    timezone: "UTC"
  });
  const response = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, {
    cache: "no-store"
  });
  if (!response.ok) throw new Error(`Open-Meteo returned ${response.status}`);

  const payload = (await response.json()) as {
    hourly?: { time?: string[]; precipitation?: number[] };
  };
  const times = payload.hourly?.time;
  const precipitation = payload.hourly?.precipitation;
  if (!Array.isArray(times) || !Array.isArray(precipitation) || times.length !== precipitation.length) {
    throw new Error("Open-Meteo returned an invalid hourly series.");
  }

  const now = Date.now();
  let currentIndex = -1;
  for (let index = 0; index < times.length; index += 1) {
    if (new Date(`${times[index]}:00Z`).valueOf() <= now) currentIndex = index;
  }
  if (currentIndex < 0) throw new Error("Open-Meteo series does not cover the current hour.");

  const sum = (hours: number) =>
    precipitation
      .slice(Math.max(0, currentIndex - hours + 1), currentIndex + 1)
      .reduce((total, value) => total + (Number.isFinite(value) ? value : 0), 0);

  return {
    rateMmPerHour: Number.isFinite(precipitation[currentIndex]) ? precipitation[currentIndex] : 0,
    accum3hMm: sum(3),
    accum24hMm: sum(24)
  };
};

const lngToGlobalPixelX = (lng: number) =>
  ((lng + 180) / 360) * 2 ** IMERG_ZOOM * IMERG_TILE_SIZE;

const latToGlobalPixelY = (lat: number) => {
  const radians = (lat * Math.PI) / 180;
  const mercator = (1 - Math.log(Math.tan(radians) + 1 / Math.cos(radians)) / Math.PI) / 2;
  return mercator * 2 ** IMERG_ZOOM * IMERG_TILE_SIZE;
};

// Counts rain-colored (non-transparent) IMERG pixels in the window around
// Mayon. Coverage is the fraction of the window where GPM currently sees rain.
const sampleImergOverMayon = async () => {
  const west = Math.floor(lngToGlobalPixelX(MAYON_LNG - SAMPLE_RADIUS_DEG));
  const east = Math.ceil(lngToGlobalPixelX(MAYON_LNG + SAMPLE_RADIUS_DEG));
  const north = Math.floor(latToGlobalPixelY(MAYON_LAT + SAMPLE_RADIUS_DEG));
  const south = Math.ceil(latToGlobalPixelY(MAYON_LAT - SAMPLE_RADIUS_DEG));

  const tiles = new Map<string, { x: number; y: number }>();
  for (let tileX = Math.floor(west / IMERG_TILE_SIZE); tileX <= Math.floor(east / IMERG_TILE_SIZE); tileX += 1) {
    for (let tileY = Math.floor(north / IMERG_TILE_SIZE); tileY <= Math.floor(south / IMERG_TILE_SIZE); tileY += 1) {
      tiles.set(`${tileX}/${tileY}`, { x: tileX, y: tileY });
    }
  }

  const decoded = new Map<string, PNG>();
  await Promise.all(
    [...tiles.values()].map(async ({ x, y }) => {
      const response = await fetch(
        `https://gibs.earthdata.nasa.gov/wmts/epsg3857/best/IMERG_Precipitation_Rate/default/default/GoogleMapsCompatible_Level6/${IMERG_ZOOM}/${y}/${x}.png`,
        { cache: "no-store" }
      );
      if (!response.ok) throw new Error(`GIBS returned ${response.status}`);
      decoded.set(`${x}/${y}`, PNG.sync.read(Buffer.from(await response.arrayBuffer())));
    })
  );

  let total = 0;
  let rainy = 0;
  for (let px = west; px <= east; px += 1) {
    for (let py = north; py <= south; py += 1) {
      const tile = decoded.get(`${Math.floor(px / IMERG_TILE_SIZE)}/${Math.floor(py / IMERG_TILE_SIZE)}`);
      if (!tile) continue;
      const localX = px % IMERG_TILE_SIZE;
      const localY = py % IMERG_TILE_SIZE;
      const alpha = tile.data[(localY * tile.width + localX) * 4 + 3];
      total += 1;
      if (alpha > 0) rainy += 1;
    }
  }

  return total > 0 ? (rainy / total) * 100 : null;
};

export const dynamic = "force-dynamic";

export async function GET() {
  if (cached && Date.now() < cached.expiresAt) {
    return Response.json(cached.payload, { headers: { "Cache-Control": "no-store" } });
  }

  let rainfall;
  try {
    rainfall = await fetchMayonRainfall();
  } catch {
    return Response.json({ error: "Mayon rainfall data is temporarily unavailable." }, { status: 502 });
  }

  let rainCoveragePercent: number | null = null;
  let sampled = false;
  try {
    rainCoveragePercent = await sampleImergOverMayon();
    sampled = rainCoveragePercent !== null;
  } catch {
    // Satellite corroboration is best-effort; the indicator still works on model rain.
  }

  const tier: LaharWatchPayload["tier"] =
    rainfall.rateMmPerHour >= HIGH_RATE_MM_PER_HOUR || rainfall.accum3hMm >= HIGH_3H_MM
      ? "high"
      : rainfall.rateMmPerHour >= MODERATE_RATE_MM_PER_HOUR || rainfall.accum3hMm >= MODERATE_3H_MM
        ? "moderate"
        : "low";

  const payload: LaharWatchPayload = {
    tier,
    rateMmPerHour: roundTo(rainfall.rateMmPerHour, 1),
    accum3hMm: roundTo(rainfall.accum3hMm, 1),
    accum24hMm: roundTo(rainfall.accum24hMm, 1),
    satellite: {
      sampled,
      rainCoveragePercent: rainCoveragePercent === null ? null : roundTo(rainCoveragePercent, 0)
    },
    computedAt: new Date().toISOString(),
    basis:
      "Unofficial heuristic from modeled rain at Mayon Volcano and NASA GPM IMERG satellite detection. Follow PHIVOLCS bulletins for official guidance."
  };

  cached = { expiresAt: Date.now() + CACHE_TTL_MS, payload };
  return Response.json(payload, { headers: { "Cache-Control": "no-store" } });
}
