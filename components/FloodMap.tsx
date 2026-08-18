"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Polygon, Point, LineString, MultiLineString, MultiPolygon } from "geojson";
import FloodLoadingIcon from "./FloodLoadingIcon";
import { DATA_SOURCES, VERIFIED_ALBAY_COVERAGE } from "@/lib/dataSources";

type WeatherResponse = {
  latitude: number;
  longitude: number;
  utc_offset_seconds: number;
  timezone_abbreviation?: string;
  current_units: {
    time: string;
    interval: string;
    temperature_2m: string;
    precipitation: string;
    weather_code: string;
    wind_speed_10m: string;
    wind_direction_10m: string;
  };
  current: {
    time: string;
    interval?: number;
    temperature_2m: number;
    precipitation: number;
    weather_code: number;
    wind_speed_10m: number;
    wind_direction_10m: number;
  };
  hourly: {
    time: string[];
    precipitation: number[];
    wind_speed_10m: number[];
    wind_direction_10m: number[];
  };
  hourly_units: {
    time: string;
    precipitation: string;
    wind_speed_10m: string;
    wind_direction_10m: string;
  };
  elevation: number;
  timezone: string;
  _provenance: {
    provider: string;
    documentation_url: string;
    dataset: string;
    served_at: string;
    requested_coordinates: {
      latitude: number;
      longitude: number;
    };
  };
};

type OfficialRainGaugeStation = {
  site_id: string;
  site_name: string;
  hourly_rain_mm: number | null;
  elevation_m: number | null;
  observed_at: string | null;
  freshness: "current" | "stale" | "unavailable";
};

type OfficialRainfallResponse = {
  provider: string;
  source_url: string;
  station_scope: "Albay";
  period: "preceding hour";
  unit: "mm";
  retrieved_at: string;
  freshness_threshold_minutes: number;
  stations: OfficialRainGaugeStation[];
};

type HydroGeometry = LineString | Polygon | MultiLineString | MultiPolygon;
type HydroFeature = Feature<HydroGeometry>;
type HydroFeatureCollection = FeatureCollection<HydroGeometry>;
type HydrologyScope = "province" | "municipality" | "barangay";
type PreparedBoundaryPart = {
  feature: Feature<Polygon>;
  bounds: [number, number, number, number];
};

type HydrologyCounts = {
  rivers: number;
  streams: number;
  canals: number;
  drains: number;
  ditches: number;
  tidalChannels: number;
  otherWaterways: number;
  waterbodies: number;
};

type HydrologyResponse = {
  data: HydroFeatureCollection;
  counts: HydrologyCounts;
  _provenance: {
    provider: "OpenStreetMap";
    copyright_url: string;
    served_at: string;
    dataset_updated_at: string | null;
    selected_area: {
      scope: HydrologyScope;
      code: string;
      name: string;
      boundary_source: string;
      boundary_snapshot: string;
      code_source: string;
      code_snapshot: string;
    };
    query_bounds: {
      south: number;
      west: number;
      north: number;
      east: number;
    };
    selection_method: "administrative-boundary-intersection";
    upstream_hosts: string[];
    retrieval_mode: "overpass";
    source_validation: {
      schema: "passed";
      attribution: "passed";
      geometry: "passed";
      freshness: "fresh-overpass-snapshot";
      snapshot_age_seconds: number | null;
      maximum_snapshot_age_seconds: number;
    };
    waterway_lines: "included" | "temporarily unavailable";
    way_waterbodies: "included" | "temporarily unavailable";
    relation_waterbodies: "included" | "temporarily unavailable";
  };
};

type PersistentHydrologyCacheEntry = {
  schemaVersion: 2;
  storedAt: number;
  payload: HydrologyResponse;
};

type BarangayProperties = {
  code: string;
  name: string;
  areaSqKm: number;
  municipalityCode: string;
  municipalityName: string;
  provinceCode: string;
  provinceName: string;
};

type BarangayDatasetMetadata = {
  province: string;
  provinceCode: string;
  snapshot: string;
  boundarySource: string;
  codeSource: string;
  featureCount: number;
};

type BarangayGeometry = Polygon | MultiPolygon;
type BarangayFeature = Feature<BarangayGeometry, BarangayProperties>;
type BarangayFeatureCollection = FeatureCollection<BarangayGeometry, BarangayProperties> & {
  metadata?: BarangayDatasetMetadata;
};

type FocusLocation = {
  lat: number;
  lng: number;
  label: string;
};

type MunicipalitySummary = {
  code: string;
  name: string;
  barangayCount: number;
  areaSqKm: number;
};

type AreaOption = {
  key: string;
  level: "province" | "municipality" | "barangay";
  label: string;
  description: string;
  municipalityCode?: string;
  barangayCode?: string;
};

type WeatherSyncReason = "initial" | "automatic" | "focus" | "reconnect" | "area";

type Analysis = {
  radiusKm: number;
  polygon: Feature<Polygon>;
  radiusAreaKm2: number;
  precipWindowMm: number;
  estimatedWaterLiters: number;
  selectedForecastHour: number;
  selectedRainRateMmPerHour: number;
  selectedWindSpeedKph: number;
  selectedWindDirectionDegrees: number;
  windowStartTime: string;
  windowEndTime: string;
};

type LayerVisibility = {
  barangays: boolean;
  rainZone: boolean;
  rainAnimation: boolean;
  waterways: boolean;
  waterAreas: boolean;
};

type HydrologyStatus = "idle" | "loading" | "ready" | "error";
type TimelinePlaybackSpeed = 1 | 2 | 3 | 4;

type RainParticle = {
  x: number;
  y: number;
  radius: number;
  speed: number;
  windResponse: number;
  turbulence: number;
  opacity: number;
};

const WEATHER_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const WEATHER_FOCUS_REFRESH_MS = 2 * 60 * 1000;
const WEATHER_STALE_AFTER_MS = 12 * 60 * 1000;
const HYDROLOGY_RESPONSE_STALE_AFTER_MS = 20 * 60 * 1000;
const HYDROLOGY_PERSISTED_CACHE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
const HYDROLOGY_CACHE_SKIP_REFRESH_MS = 10 * 60 * 1000;
const HYDROLOGY_CACHE_KEY_PREFIX = "albay-flood-monitor:hydrology:v2:";
const HYDROLOGY_CACHE_MAX_ENTRIES = 6;
const HYDROLOGY_MAX_OVERPASS_LAG_SECONDS = 6 * 60 * 60;
const SOURCE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const TIMELINE_FRAME_INTERVAL_MS = 900;
const HYDROLOGY_COUNT_KEYS: Array<keyof HydrologyCounts> = [
  "rivers",
  "streams",
  "canals",
  "drains",
  "ditches",
  "tidalChannels",
  "otherWaterways",
  "waterbodies"
];
const ALLOWED_WATERWAY_TYPES = new Set(["river", "stream", "canal", "drain", "ditch", "tidal_channel"]);
const ALLOWED_HYDROLOGY_HOSTS = new Set(
  DATA_SOURCES.hydrology.overpassEndpoints.map((endpoint) => new URL(endpoint).hostname)
);

const combineAreaBoundaries = (
  area: BarangayFeature | BarangayFeatureCollection | null
): Feature<Polygon | MultiPolygon> | null => {
  if (!area) return null;
  const features = area.type === "FeatureCollection" ? area.features : [area];
  if (features.length === 0) return null;
  if (features.length === 1) return features[0];

  const flattened = turf.flatten(
    turf.featureCollection(features)
  ) as FeatureCollection<Polygon, BarangayProperties>;
  const dissolved = turf.dissolve(flattened);
  if (dissolved.features.length === 1) return dissolved.features[0];

  const polygons: MultiPolygon["coordinates"] = [];
  dissolved.features.forEach((feature) => {
    polygons.push(feature.geometry.coordinates);
  });
  return turf.multiPolygon(polygons);
};

const prepareBoundaryParts = (
  boundary: Feature<Polygon | MultiPolygon> | null
): PreparedBoundaryPart[] => {
  if (!boundary) return [];
  return (turf.flatten(boundary) as FeatureCollection<Polygon>).features.map((feature) => ({
    feature,
    bounds: turf.bbox(feature) as [number, number, number, number]
  }));
};

const intersectsBoundaryParts = (feature: Feature, boundaryParts: PreparedBoundaryPart[]) => {
  const [featureWest, featureSouth, featureEast, featureNorth] = turf.bbox(feature);
  return boundaryParts.some(({ feature: boundaryPart, bounds: [west, south, east, north] }) => {
    if (featureEast < west || featureWest > east || featureNorth < south || featureSouth > north) return false;
    return turf.booleanIntersects(feature, boundaryPart);
  });
};

const hydrologyCacheKey = (areaKey: string) => `${HYDROLOGY_CACHE_KEY_PREFIX}${areaKey}`;

const removeHydrologyCacheEntry = (key: string) => {
  try {
    window.localStorage.removeItem(key);
  } catch {
    // Storage can be unavailable in private browsing or restricted contexts.
  }
};

const readHydrologyCacheEntry = (key: string): PersistentHydrologyCacheEntry | null => {
  try {
    const stored = window.localStorage.getItem(key);
    if (!stored) return null;
    const entry = JSON.parse(stored) as PersistentHydrologyCacheEntry;
    if (
      entry?.schemaVersion !== 2 ||
      !Number.isFinite(entry.storedAt) ||
      typeof entry.payload !== "object" ||
      entry.payload === null
    ) {
      removeHydrologyCacheEntry(key);
      return null;
    }
    return entry;
  } catch {
    removeHydrologyCacheEntry(key);
    return null;
  }
};

const trimHydrologyCache = (preserveKey: string) => {
  try {
    const entries: Array<{ key: string; storedAt: number }> = [];
    for (let index = 0; index < window.localStorage.length; index += 1) {
      const key = window.localStorage.key(index);
      if (!key?.startsWith(HYDROLOGY_CACHE_KEY_PREFIX) || key === preserveKey) continue;
      try {
        const value = JSON.parse(window.localStorage.getItem(key) ?? "null") as { storedAt?: unknown } | null;
        entries.push({ key, storedAt: typeof value?.storedAt === "number" ? value.storedAt : 0 });
      } catch {
        entries.push({ key, storedAt: 0 });
      }
    }
    entries
      .sort((a, b) => b.storedAt - a.storedAt)
      .slice(HYDROLOGY_CACHE_MAX_ENTRIES - 1)
      .forEach((entry) => window.localStorage.removeItem(entry.key));
  } catch {
    // Cache eviction is best-effort and must never block live GIS data.
  }
};

const writeHydrologyCacheEntry = (key: string, payload: HydrologyResponse) => {
  const serialized = JSON.stringify({ schemaVersion: 2, storedAt: Date.now(), payload });
  try {
    trimHydrologyCache(key);
    window.localStorage.setItem(key, serialized);
  } catch {
    try {
      for (let index = window.localStorage.length - 1; index >= 0; index -= 1) {
        const storedKey = window.localStorage.key(index);
        if (storedKey?.startsWith(HYDROLOGY_CACHE_KEY_PREFIX) && storedKey !== key) {
          window.localStorage.removeItem(storedKey);
        }
      }
      window.localStorage.setItem(key, serialized);
    } catch {
      // The app continues with its in-memory response when persistent storage is unavailable.
    }
  }
};

const validateHydrologyResponse = (
  payloadValue: unknown,
  expectedScope: HydrologyScope,
  expectedCode: string,
  expectedBounds: [number, number, number, number],
  selectedBoundaryParts: PreparedBoundaryPart[],
  maximumResponseAgeMs: number,
  validationTime = Date.now()
): payloadValue is HydrologyResponse => {
  const payload = payloadValue as HydrologyResponse;
  const hasValidFeatures =
    payload?.data?.type === "FeatureCollection" &&
    Array.isArray(payload.data.features) &&
    payload.data.features.every((feature) => {
      const properties = feature.properties;
      const sourceEditedAt = new Date(properties?.sourceLastEditedAt).valueOf();
      const isWaterway =
        properties?.featureClass === "waterway" &&
        properties.sourceType === "way" &&
        (feature.geometry?.type === "LineString" || feature.geometry?.type === "MultiLineString") &&
        ALLOWED_WATERWAY_TYPES.has(properties.waterway);
      const isWaterbody =
        properties?.featureClass === "waterbody" &&
        (feature.geometry?.type === "Polygon" || feature.geometry?.type === "MultiPolygon") &&
        (properties.sourceType === "way" || properties.sourceType === "relation");

      const hasValidSource =
        feature.type === "Feature" &&
        (isWaterway || isWaterbody) &&
        Number.isSafeInteger(properties?.sourceId) &&
        properties!.sourceId > 0 &&
        Number.isSafeInteger(properties?.sourceVersion) &&
        properties!.sourceVersion > 0 &&
        Number.isFinite(sourceEditedAt) &&
        sourceEditedAt <= validationTime + SOURCE_CLOCK_SKEW_MS &&
        properties?.sourceUrl ===
          `https://www.openstreetmap.org/${properties.sourceType}/${properties.sourceId}`;
      if (!hasValidSource) return false;

      try {
        return intersectsBoundaryParts(feature, selectedBoundaryParts);
      } catch {
        return false;
      }
    });
  const hasValidCounts =
    payload?.counts &&
    HYDROLOGY_COUNT_KEYS.every(
      (key) => Number.isSafeInteger(payload.counts[key]) && payload.counts[key] >= 0
    );
  const countTotal = hasValidCounts
    ? HYDROLOGY_COUNT_KEYS.reduce((total, key) => total + payload.counts[key], 0)
    : -1;
  const servedAt = new Date(payload?._provenance?.served_at).valueOf();
  const sourceDatasetUpdatedAt = payload?._provenance?.dataset_updated_at
    ? new Date(payload._provenance.dataset_updated_at).valueOf()
    : null;
  const validation = payload?._provenance?.source_validation;
  const hasValidFreshness =
    validation?.schema === "passed" &&
    validation.attribution === "passed" &&
    validation.geometry === "passed" &&
    validation.maximum_snapshot_age_seconds === HYDROLOGY_MAX_OVERPASS_LAG_SECONDS &&
    validation.freshness === "fresh-overpass-snapshot" &&
    Number.isFinite(validation.snapshot_age_seconds) &&
    validation.snapshot_age_seconds! >= 0 &&
    validation.snapshot_age_seconds! <= validation.maximum_snapshot_age_seconds &&
    sourceDatasetUpdatedAt !== null &&
    sourceDatasetUpdatedAt <= servedAt + SOURCE_CLOCK_SKEW_MS &&
    validationTime - sourceDatasetUpdatedAt <= validation.maximum_snapshot_age_seconds * 1000;
  const hasValidCompleteness = [
    payload?._provenance?.waterway_lines,
    payload?._provenance?.way_waterbodies,
    payload?._provenance?.relation_waterbodies
  ].every((state) => state === "included");
  const queryBounds = payload?._provenance?.query_bounds;
  const [expectedWest, expectedSouth, expectedEast, expectedNorth] = expectedBounds;
  const hasExpectedBounds =
    Number.isFinite(queryBounds?.south) &&
    Number.isFinite(queryBounds?.west) &&
    Number.isFinite(queryBounds?.north) &&
    Number.isFinite(queryBounds?.east) &&
    Math.abs(queryBounds.south - expectedSouth) < 1e-6 &&
    Math.abs(queryBounds.west - expectedWest) < 1e-6 &&
    Math.abs(queryBounds.north - expectedNorth) < 1e-6 &&
    Math.abs(queryBounds.east - expectedEast) < 1e-6;
  const hasValidProvenance =
    payload?._provenance?.provider === "OpenStreetMap" &&
    payload._provenance.copyright_url === DATA_SOURCES.hydrology.copyrightUrl &&
    Number.isFinite(servedAt) &&
    servedAt <= validationTime + SOURCE_CLOCK_SKEW_MS &&
    validationTime - servedAt <= maximumResponseAgeMs &&
    payload._provenance.selected_area?.scope === expectedScope &&
    payload._provenance.selected_area?.code === expectedCode &&
    payload._provenance.selected_area?.boundary_source === "NAMRIA" &&
    payload._provenance.selected_area?.boundary_snapshot === DATA_SOURCES.administrativeGeometry.snapshot &&
    payload._provenance.selected_area?.code_source === "Philippine Statistics Authority PSGC" &&
    payload._provenance.selected_area?.code_snapshot === DATA_SOURCES.administrativeNames.snapshot &&
    payload._provenance.selection_method === "administrative-boundary-intersection" &&
    payload._provenance.retrieval_mode === "overpass" &&
    hasExpectedBounds &&
    Array.isArray(payload._provenance.upstream_hosts) &&
    payload._provenance.upstream_hosts.length > 0 &&
    payload._provenance.upstream_hosts.every((host) => ALLOWED_HYDROLOGY_HOSTS.has(host)) &&
    hasValidCompleteness &&
    hasValidFreshness;

  return hasValidFeatures && countTotal === payload?.data?.features.length && hasValidProvenance;
};
const ALBAY_PROVINCE_CODE = "05005";
const RAIN_ANALYSIS_ZONE_COLOR = "#2f9d67";
// A generous margin keeps Albay's outer islands visible in the pitched 3D view
// while still preventing users from navigating far away from the province.
const ALBAY_MAP_BOUNDS_PADDING_RATIO = 0.3;
const ALBAY_VIEWPORT_FOOTPRINT_ALLOWANCE = 1.15;
// Bootstrap coordinate generated with Turf pointOnFeature from the validated
// bundled province collection. Network requests wait for that collection to
// pass validation, so this value is only an initial render seed.
const ALBAY_PROVINCE_FOCUS: FocusLocation = {
  lat: 13.252353189500042,
  lng: 123.75041695450005,
  label: "Albay Province"
};

const WEATHER_CODE_MAP: Record<number, string> = {
  0: "Clear sky",
  1: "Mostly clear",
  2: "Partly cloudy",
  3: "Overcast",
  45: "Fog",
  48: "Freezing fog",
  51: "Light drizzle",
  53: "Moderate drizzle",
  55: "Dense drizzle",
  56: "Light freezing drizzle",
  57: "Dense freezing drizzle",
  61: "Light rain",
  63: "Moderate rain",
  65: "Heavy rain",
  66: "Light freezing rain",
  67: "Heavy freezing rain",
  71: "Light snow",
  73: "Moderate snow",
  75: "Heavy snow",
  77: "Snow grains",
  80: "Light rain showers",
  81: "Moderate rain showers",
  82: "Violent rain showers",
  85: "Light snow showers",
  86: "Heavy snow showers",
  95: "Thunderstorm",
  96: "Thunderstorm with light hail",
  99: "Thunderstorm with heavy hail"
};

const WIND_DIRECTION_LABELS = ["N", "NE", "E", "SE", "S", "SW", "W", "NW"] as const;

const formatWindDirection = (degrees: number) => {
  const normalizedDegrees = ((degrees % 360) + 360) % 360;
  return WIND_DIRECTION_LABELS[Math.round(normalizedDegrees / 45) % WIND_DIRECTION_LABELS.length];
};

const INITIAL_LOADING_STEPS: ReadonlyArray<{ label: string; title: string; detail: string }> = [
  {
    label: "Area",
    title: "Loading Albay coverage",
    detail: "Preparing province-wide boundaries with Albay Province as the default focus."
  },
  {
    label: "Weather",
    title: "Syncing rainfall data",
    detail: "Loading model-based current and forecast precipitation from Open-Meteo."
  },
  {
    label: "3D map",
    title: "Building the terrain view",
    detail: "Loading satellite imagery, elevation terrain, and map controls."
  },
  {
    label: "GIS layers",
    title: "Indexing nearby waterways",
    detail: "Loading volunteered OpenStreetMap water features and verified administrative boundaries."
  }
];

const READY_LOADING_STAGE = {
  title: "Source data ready",
  detail: "Weather-model, boundary, terrain, and contextual GIS sources are loaded."
};

const toFeatureCollection = (): HydroFeatureCollection => ({
  type: "FeatureCollection",
  features: []
});

const toBarangayFeatureCollection = (): BarangayFeatureCollection => ({
  type: "FeatureCollection",
  features: []
});

const validateAndNormalizeBarangayData = (value: unknown): BarangayFeatureCollection => {
  const collection = value as Partial<BarangayFeatureCollection>;

  if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
    throw new Error("Barangay boundary file is not a GeoJSON FeatureCollection.");
  }

  const metadata = collection.metadata;
  if (
    metadata?.province !== "Albay" ||
    metadata.provinceCode !== ALBAY_PROVINCE_CODE ||
    metadata.snapshot !== DATA_SOURCES.administrativeNames.snapshot ||
    metadata.boundarySource !== "NAMRIA" ||
    metadata.codeSource !== "Philippine Statistics Authority PSGC" ||
    metadata.featureCount !== VERIFIED_ALBAY_COVERAGE.barangays ||
    collection.features.length !== metadata.featureCount
  ) {
    throw new Error("Barangay boundary provenance metadata does not match the verified Albay dataset.");
  }

  const seenBarangayCodes = new Set<string>();
  const municipalityCodes = new Set<string>();
  const normalizedFeatures = collection.features.map((candidate, index) => {
    const feature = candidate as Partial<BarangayFeature>;
    const properties = feature.properties as Partial<BarangayProperties> | undefined;
    const geometry = feature.geometry;

    if (
      feature.type !== "Feature" ||
      !geometry ||
      (geometry.type !== "Polygon" && geometry.type !== "MultiPolygon") ||
      !properties ||
      !/^\d{10}$/.test(properties.code ?? "") ||
      !/^\d{10}$/.test(properties.municipalityCode ?? "") ||
      properties.provinceCode !== ALBAY_PROVINCE_CODE ||
      properties.provinceName !== "Albay" ||
      typeof properties.name !== "string" ||
      properties.name.trim().length === 0 ||
      typeof properties.municipalityName !== "string" ||
      properties.municipalityName.trim().length === 0
    ) {
      throw new Error(`Barangay boundary feature ${index + 1} is incomplete or invalid.`);
    }

    const barangayCode = properties.code as string;
    const municipalityCode = properties.municipalityCode as string;

    if (seenBarangayCodes.has(barangayCode)) {
      throw new Error(`Barangay boundary file contains duplicate PSGC code ${barangayCode}.`);
    }

    const areaSqKm = turf.area(feature as BarangayFeature) / 1_000_000;
    if (!Number.isFinite(areaSqKm) || areaSqKm <= 0) {
      throw new Error(`Barangay ${barangayCode} has an invalid boundary area.`);
    }

    seenBarangayCodes.add(barangayCode);
    municipalityCodes.add(municipalityCode);

    return {
      ...(feature as BarangayFeature),
      properties: {
        ...(properties as BarangayProperties),
        areaSqKm
      }
    };
  });

  if (municipalityCodes.size !== VERIFIED_ALBAY_COVERAGE.localGovernmentUnits) {
    throw new Error(
      `Boundary file has ${municipalityCodes.size} LGUs; PSA reports ${VERIFIED_ALBAY_COVERAGE.localGovernmentUnits}.`
    );
  }

  return {
    type: "FeatureCollection",
    metadata,
    features: normalizedFeatures
  };
};

const barangayNameCollator = new Intl.Collator("en", { numeric: true, sensitivity: "base" });

const formatMunicipalityName = (name: string) => {
  if (name === "City of Ligao") return "Ligao City";
  if (name === "City of Tabaco") return "Tabaco City";
  if (name === "Legazpi City (Capital)") return "Legazpi City";
  return name;
};

const normalizeAreaSearch = (value: string) =>
  value
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLocaleLowerCase()
    .trim();

const findClosestTimeIndex = (times: string[], targetTime: string) => {
  const target = new Date(targetTime).valueOf();
  if (!Number.isFinite(target) || times.length === 0) return 0;

  return times.reduce((closestIndex, time, index) => {
    const candidate = new Date(time).valueOf();
    const closest = new Date(times[closestIndex]).valueOf();
    return Math.abs(candidate - target) < Math.abs(closest - target) ? index : closestIndex;
  }, 0);
};

const shiftLocalIsoTime = (isoTime: string, offsetMinutes: number) => {
  const wallClockTime = new Date(`${isoTime}Z`);
  if (Number.isNaN(wallClockTime.valueOf())) return isoTime;
  return new Date(wallClockTime.valueOf() + offsetMinutes * 60_000).toISOString().slice(0, 16);
};

export default function FloodMap() {
  const mapContainerRef = useRef<HTMLDivElement | null>(null);
  const rainCanvasRef = useRef<HTMLCanvasElement | null>(null);
  const mapRef = useRef<mapboxgl.Map | null>(null);
  const markerRef = useRef<mapboxgl.Marker | null>(null);
  const weatherFocusKeyRef = useRef<string | null>(null);
  const weatherRef = useRef<WeatherResponse | null>(null);
  const forecastHourRef = useRef(0);
  const weatherRequestIdRef = useRef(0);
  const weatherLastRequestAtRef = useRef(0);
  const lastWeatherUpdatedAtRef = useRef<number | null>(null);
  const officialRainfallRequestIdRef = useRef(0);
  const hydrologyRequestIdRef = useRef(0);
  const radiusWasAdjustedRef = useRef(false);
  const lastMapFitRef = useRef("");
  const areaPickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const areaSearchInputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState("Preparing Albay Province data...");
  const [weather, setWeather] = useState<WeatherResponse | null>(null);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [isWeatherRefreshing, setIsWeatherRefreshing] = useState(false);
  const [lastWeatherUpdatedAt, setLastWeatherUpdatedAt] = useState<number | null>(null);
  const [officialRainfall, setOfficialRainfall] = useState<OfficialRainfallResponse | null>(null);
  const [officialRainfallError, setOfficialRainfallError] = useState<string | null>(null);
  const [isOfficialRainfallRefreshing, setIsOfficialRainfallRefreshing] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [clockNow, setClockNow] = useState<number | null>(null);
  const [radiusKm, setRadiusKm] = useState(0);
  const [hoursWindow, setHoursWindow] = useState(24);
  const [forecastHour, setForecastHour] = useState(0);
  const [isTimelinePlaying, setIsTimelinePlaying] = useState(false);
  const [timelinePlaybackSpeed, setTimelinePlaybackSpeed] = useState<TimelinePlaybackSpeed>(1);
  const [barangayData, setBarangayData] = useState<BarangayFeatureCollection>(toBarangayFeatureCollection());
  const [selectedMunicipalityCode, setSelectedMunicipalityCode] = useState("");
  const [selectedBarangayCode, setSelectedBarangayCode] = useState("");
  const [barangayError, setBarangayError] = useState<string | null>(null);
  const [isAreaPickerOpen, setIsAreaPickerOpen] = useState(false);
  const [areaSearchQuery, setAreaSearchQuery] = useState("");
  const [activeAreaOptionIndex, setActiveAreaOptionIndex] = useState(0);
  const [layerVisibility, setLayerVisibility] = useState<LayerVisibility>({
    barangays: true,
    rainZone: true,
    rainAnimation: true,
    waterways: true,
    waterAreas: true
  });
  const [mapLoaded, setMapLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hydroData, setHydroData] = useState<HydroFeatureCollection>(toFeatureCollection());
  const [hydroError, setHydroError] = useState<string | null>(null);
  const [hydrologyStatus, setHydrologyStatus] = useState<HydrologyStatus>("idle");
  const [hydrologyRetrievedAt, setHydrologyRetrievedAt] = useState<number | null>(null);
  const [hydrologyDatasetUpdatedAt, setHydrologyDatasetUpdatedAt] = useState<number | null>(null);
  const [hasFinishedInitialLoad, setHasFinishedInitialLoad] = useState(false);
  const [isMobileLegendOpen, setIsMobileLegendOpen] = useState(false);
  const [isReadingsPanelOpen, setIsReadingsPanelOpen] = useState(true);

  const mapToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const barangayOptions = useMemo(
    () => [...barangayData.features].sort((a, b) => barangayNameCollator.compare(a.properties.name, b.properties.name)),
    [barangayData]
  );
  const albayProvinceBounds = useMemo<[number, number, number, number] | null>(() => {
    if (barangayData.features.length === 0) return null;
    return turf.bbox(barangayData) as [number, number, number, number];
  }, [barangayData]);
  const provinceCoverageRadiusKm = useMemo(() => {
    if (barangayData.features.length === 0) return 0;

    const provinceFocus = turf.pointOnFeature(barangayData);
    let farthestBoundaryDistanceKm = 0;
    turf.coordEach(barangayData, (coordinate) => {
      farthestBoundaryDistanceKm = Math.max(
        farthestBoundaryDistanceKm,
        turf.distance(provinceFocus, coordinate, { units: "kilometers" })
      );
    });
    return Math.ceil(farthestBoundaryDistanceKm);
  }, [barangayData]);
  const radiusSliderMaxKm = Math.max(60, Math.ceil(provinceCoverageRadiusKm / 10) * 10);
  const municipalityOptions = useMemo<MunicipalitySummary[]>(() => {
    const municipalityMap = new Map<string, MunicipalitySummary>();

    barangayData.features.forEach((feature) => {
      const { municipalityCode, municipalityName, areaSqKm } = feature.properties;
      const current = municipalityMap.get(municipalityCode);

      if (current) {
        current.barangayCount += 1;
        current.areaSqKm += areaSqKm;
      } else {
        municipalityMap.set(municipalityCode, {
          code: municipalityCode,
          name: formatMunicipalityName(municipalityName),
          barangayCount: 1,
          areaSqKm
        });
      }
    });

    return [...municipalityMap.values()].sort((a, b) => barangayNameCollator.compare(a.name, b.name));
  }, [barangayData]);
  const selectedBarangay = useMemo(
    () => barangayData.features.find((feature) => feature.properties.code === selectedBarangayCode) ?? null,
    [barangayData, selectedBarangayCode]
  );
  const selectedMunicipality = useMemo(
    () => municipalityOptions.find((municipality) => municipality.code === selectedMunicipalityCode) ?? null,
    [municipalityOptions, selectedMunicipalityCode]
  );
  const selectedMunicipalityFeatures = useMemo<BarangayFeatureCollection>(
    () => ({
      type: "FeatureCollection",
      features: barangayData.features.filter(
        (feature) => feature.properties.municipalityCode === selectedMunicipalityCode
      )
    }),
    [barangayData, selectedMunicipalityCode]
  );
  const selectedAreaGeoJson = useMemo<BarangayFeature | BarangayFeatureCollection | null>(() => {
    if (selectedBarangay) return selectedBarangay;
    if (selectedMunicipalityCode && selectedMunicipalityFeatures.features.length > 0) {
      return selectedMunicipalityFeatures;
    }
    return barangayData.features.length > 0 ? barangayData : null;
  }, [barangayData, selectedBarangay, selectedMunicipalityCode, selectedMunicipalityFeatures]);
  const location = useMemo<FocusLocation>(() => {
    if (!selectedAreaGeoJson) {
      return ALBAY_PROVINCE_FOCUS;
    }

    const [lng, lat] = turf.pointOnFeature(selectedAreaGeoJson).geometry.coordinates;

    if (!selectedBarangay) {
      return {
        lat,
        lng,
        label: selectedMunicipality ? `${selectedMunicipality.name}, Albay` : ALBAY_PROVINCE_FOCUS.label
      };
    }

    return {
      lat,
      lng,
      label: `${selectedBarangay.properties.name}, ${formatMunicipalityName(selectedBarangay.properties.municipalityName)}`
    };
  }, [selectedAreaGeoJson, selectedBarangay, selectedMunicipality, selectedMunicipalityCode]);
  const selectedAreaKey = selectedBarangayCode
    ? `barangay:${selectedBarangayCode}`
    : selectedMunicipalityCode
      ? `municipality:${selectedMunicipalityCode}`
      : `province:${ALBAY_PROVINCE_CODE}`;
  const selectedHydrologyScope: HydrologyScope = selectedBarangayCode
    ? "barangay"
    : selectedMunicipalityCode
      ? "municipality"
      : "province";
  const selectedHydrologyCode = selectedBarangayCode || selectedMunicipalityCode || ALBAY_PROVINCE_CODE;
  const selectedHydrologyBoundary = useMemo(
    () => combineAreaBoundaries(selectedAreaGeoJson),
    [selectedAreaGeoJson]
  );
  const selectedHydrologyBoundaryParts = useMemo(
    () => prepareBoundaryParts(selectedHydrologyBoundary),
    [selectedHydrologyBoundary]
  );
  const selectedHydrologyBounds = useMemo<[number, number, number, number] | null>(
    () => selectedHydrologyBoundary ? turf.bbox(selectedHydrologyBoundary) as [number, number, number, number] : null,
    [selectedHydrologyBoundary]
  );
  const selectedAreaLevel = selectedBarangay ? "Barangay" : selectedMunicipality ? "City / municipality" : "Province";
  const selectedAreaSqKm = selectedBarangay
    ? selectedBarangay.properties.areaSqKm
    : selectedMunicipality
      ? selectedMunicipality.areaSqKm
      : barangayData.features.reduce((total, feature) => total + feature.properties.areaSqKm, 0);
  const selectedBoundaryFilter = useMemo(
    () =>
      (selectedBarangayCode
        ? ["==", ["get", "code"], selectedBarangayCode]
        : selectedMunicipalityCode
          ? ["==", ["get", "municipalityCode"], selectedMunicipalityCode]
          : ["==", ["get", "provinceCode"], ALBAY_PROVINCE_CODE]) as mapboxgl.FilterSpecification,
    [selectedBarangayCode, selectedMunicipalityCode]
  );
  const areaPickerLabel = selectedBarangay
    ? `${selectedBarangay.properties.name} · ${formatMunicipalityName(selectedBarangay.properties.municipalityName)}`
    : selectedMunicipality
      ? `${selectedMunicipality.name} · ${selectedMunicipality.barangayCount} barangays`
      : municipalityOptions.length > 0
        ? `Albay Province · ${municipalityOptions.length} LGUs`
        : "Albay Province · Loading verified coverage";
  const areaOptions = useMemo<AreaOption[]>(() => {
    const provinceOption: AreaOption = {
      key: `province:${ALBAY_PROVINCE_CODE}`,
      level: "province",
      label: "All Albay Province",
      description:
        barangayData.features.length > 0
          ? `${municipalityOptions.length} cities & municipalities · ${barangayData.features.length} barangays`
          : "Loading verified PSA / NAMRIA coverage"
    };
    const municipalityAreaOptions: AreaOption[] = municipalityOptions.map((municipality) => ({
      key: `municipality:${municipality.code}`,
      level: "municipality",
      label: municipality.name,
      description: `${municipality.barangayCount} barangays · Albay`,
      municipalityCode: municipality.code
    }));
    const barangayAreaOptions: AreaOption[] = barangayOptions.map((barangay) => ({
      key: `barangay:${barangay.properties.code}`,
      level: "barangay",
      label: barangay.properties.name,
      description: `${formatMunicipalityName(barangay.properties.municipalityName)} · Barangay`,
      municipalityCode: barangay.properties.municipalityCode,
      barangayCode: barangay.properties.code
    }));
    const normalizedQuery = normalizeAreaSearch(areaSearchQuery);

    if (!normalizedQuery) {
      const currentMunicipalityBarangays = barangayAreaOptions.filter(
        (option) => option.municipalityCode === selectedMunicipalityCode
      );
      return [provinceOption, ...municipalityAreaOptions, ...currentMunicipalityBarangays];
    }

    return [provinceOption, ...municipalityAreaOptions, ...barangayAreaOptions]
      .filter((option) => normalizeAreaSearch(`${option.label} ${option.description}`).includes(normalizedQuery))
      .slice(0, 100);
  }, [areaSearchQuery, barangayData.features.length, barangayOptions, municipalityOptions, selectedMunicipalityCode]);

  const closeAreaPicker = useCallback((restoreFocus = true) => {
    setIsAreaPickerOpen(false);
    setAreaSearchQuery("");
    setActiveAreaOptionIndex(0);

    if (restoreFocus) {
      window.requestAnimationFrame(() => areaPickerTriggerRef.current?.focus());
    }
  }, []);

  const openAreaPicker = useCallback(() => {
    setAreaSearchQuery("");
    setActiveAreaOptionIndex(0);
    setIsAreaPickerOpen(true);
  }, []);

  const selectAreaOption = useCallback(
    (option: AreaOption) => {
      if (option.level === "province") {
        setSelectedMunicipalityCode("");
        setSelectedBarangayCode("");
      } else if (option.level === "municipality") {
        setSelectedMunicipalityCode(option.municipalityCode ?? "");
        setSelectedBarangayCode("");
      } else {
        setSelectedMunicipalityCode(option.municipalityCode ?? "");
        setSelectedBarangayCode(option.barangayCode ?? "");
      }

      lastMapFitRef.current = "";
      closeAreaPicker();
    },
    [closeAreaPicker]
  );

  useEffect(() => {
    if (provinceCoverageRadiusKm <= 0 || radiusWasAdjustedRef.current) return;
    setRadiusKm(provinceCoverageRadiusKm);
  }, [provinceCoverageRadiusKm]);

  useEffect(() => {
    if (!isAreaPickerOpen) return;

    const focusFrame = window.requestAnimationFrame(() => areaSearchInputRef.current?.focus());
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeAreaPicker();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [closeAreaPicker, isAreaPickerOpen]);

  useEffect(() => {
    setActiveAreaOptionIndex((current) => Math.min(current, Math.max(0, areaOptions.length - 1)));
  }, [areaOptions.length]);

  const weatherHourCount = weather?.hourly.time.length ?? 0;
  const hasWeather = weatherHourCount > 0;
  const safeHours = Math.max(1, Math.min(hoursWindow, weatherHourCount || 48, 48));
  const maxForecastHour = Math.max(0, weatherHourCount - 1);
  const safeForecastHour = Math.min(Math.max(0, forecastHour), maxForecastHour);

  const getWeatherLabel = useCallback((code: number) => {
    return WEATHER_CODE_MAP[code] ?? `Weather code ${code}`;
  }, []);

  const formatNumber = (value: number, decimals = 1) =>
    new Intl.NumberFormat("en-US", { maximumFractionDigits: decimals }).format(value);

  const formatCompactNumber = (value: number, decimals = 2) =>
    new Intl.NumberFormat("en-US", {
      notation: "compact",
      compactDisplay: "short",
      maximumFractionDigits: decimals
    }).format(value);

  const formatTime = useCallback((isoTime: string) => {
    // Open-Meteo returns local wall-clock timestamps without a UTC offset when
    // timezone=auto. Treat them as wall-clock values so browser timezone does
    // not shift Albay dates and hours for users viewing from another region.
    const hasExplicitOffset = /(?:Z|[+-]\d{2}:?\d{2})$/i.test(isoTime);
    const date = new Date(hasExplicitOffset ? isoTime : `${isoTime}Z`);
    if (Number.isNaN(date.valueOf())) return isoTime;

    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
      ...(hasExplicitOffset ? {} : { timeZone: "UTC" })
    });
  }, []);

  const analysis: Analysis | null = useMemo(() => {
    if (!weather) return null;

    const circle = turf.circle([location.lng, location.lat], radiusKm, {
      steps: 80,
      units: "kilometers"
    }) as Feature<Polygon>;
    const areaSqM = turf.area(circle);
    const safeAreaSqM = Number.isFinite(areaSqM) ? areaSqM : 0;

    const start = Math.max(0, safeForecastHour - safeHours + 1);
    const availableHours = weather.hourly.precipitation.slice(start, safeForecastHour + 1);
    const precipWindowMm = availableHours.reduce((acc, value) => acc + value, 0);
    const currentWeatherHour = findClosestTimeIndex(weather.hourly.time, weather.current.time);
    const currentIntervalSeconds = Math.max(1, weather.current.interval ?? 3600);
    const currentRainRateMmPerHour = weather.current.precipitation * (3600 / currentIntervalSeconds);
    const selectedRainRateMmPerHour =
      safeForecastHour === currentWeatherHour
        ? currentRainRateMmPerHour
        : weather.hourly.precipitation[safeForecastHour];
    const selectedWindSpeedKph =
      safeForecastHour === currentWeatherHour
        ? weather.current.wind_speed_10m
        : weather.hourly.wind_speed_10m[safeForecastHour];
    const selectedWindDirectionDegrees =
      safeForecastHour === currentWeatherHour
        ? weather.current.wind_direction_10m
        : weather.hourly.wind_direction_10m[safeForecastHour];
    const estimatedWaterLiters = safeAreaSqM * precipWindowMm;

    return {
      radiusKm,
      polygon: circle,
      radiusAreaKm2: safeAreaSqM / 1_000_000,
      precipWindowMm,
      estimatedWaterLiters,
      selectedForecastHour: safeForecastHour,
      selectedRainRateMmPerHour,
      selectedWindSpeedKph,
      selectedWindDirectionDegrees,
      windowStartTime: shiftLocalIsoTime(weather.hourly.time[start], -60),
      windowEndTime: weather.hourly.time[safeForecastHour]
    };
  }, [location, weather, radiusKm, safeHours, safeForecastHour]);

  const hydroCounts = useMemo(
    () =>
      hydroData.features.reduce(
        (counts, feature) => {
          if (feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon") {
            counts.waterAreas += 1;
          } else {
            counts.waterways += 1;
            switch (feature.properties?.waterway) {
              case "river": counts.rivers += 1; break;
              case "stream": counts.streams += 1; break;
              case "canal": counts.canals += 1; break;
              case "drain": counts.drains += 1; break;
              case "ditch": counts.ditches += 1; break;
            }
          }
          return counts;
        },
        { waterways: 0, waterAreas: 0, rivers: 0, streams: 0, canals: 0, drains: 0, ditches: 0 }
      ),
    [hydroData]
  );

  const fetchHydrology = useCallback(
    async () => {
      if (!selectedHydrologyBoundary || !selectedHydrologyBounds) return;

      const requestId = ++hydrologyRequestIdRef.current;
      const cacheKey = hydrologyCacheKey(selectedAreaKey);
      setHydroError(null);
      const applyPayload = (payload: HydrologyResponse, source: "cache" | "network") => {
        setHydroError(null);
        const retrievedAt = new Date(payload._provenance.served_at).valueOf();
        const datasetUpdatedAt = payload._provenance.dataset_updated_at
          ? new Date(payload._provenance.dataset_updated_at).valueOf()
          : null;
        setHydroData(payload.data);
        setHydrologyStatus("ready");
        setHydrologyRetrievedAt(retrievedAt);
        setHydrologyDatasetUpdatedAt(datasetUpdatedAt);
        setStatus(
          source === "cache"
            ? `Loaded ${payload.data.features.length} validated OpenStreetMap water features for ${payload._provenance.selected_area.name} from the browser cache.`
            : `Loaded ${payload.data.features.length} current OpenStreetMap water features intersecting ${payload._provenance.selected_area.name}.`
        );
      };

      let cachedPayload: HydrologyResponse | null = null;
      const cachedEntry = readHydrologyCacheEntry(cacheKey);
      if (
        cachedEntry &&
        validateHydrologyResponse(
          cachedEntry.payload,
          selectedHydrologyScope,
          selectedHydrologyCode,
          selectedHydrologyBounds,
          selectedHydrologyBoundaryParts,
          HYDROLOGY_PERSISTED_CACHE_MAX_AGE_MS
        )
      ) {
        cachedPayload = cachedEntry.payload;
        applyPayload(cachedPayload, "cache");
        const cacheAgeMs = Date.now() - new Date(cachedPayload._provenance.served_at).valueOf();
        const hasAllCategories =
          cachedPayload._provenance.waterway_lines === "included" &&
          cachedPayload._provenance.way_waterbodies === "included" &&
          cachedPayload._provenance.relation_waterbodies === "included";
        if (cacheAgeMs <= HYDROLOGY_CACHE_SKIP_REFRESH_MS && hasAllCategories) return;
        setStatus("Showing validated cached water features while checking for an updated OSM snapshot...");
      } else {
        if (cachedEntry) removeHydrologyCacheEntry(cacheKey);
        setStatus(`Loading all mapped water features for ${areaPickerLabel}...`);
        setHydrologyStatus("loading");
        setHydrologyRetrievedAt(null);
        setHydrologyDatasetUpdatedAt(null);
      }

      try {
        const params = new URLSearchParams({
          scope: selectedHydrologyScope,
          code: selectedHydrologyCode
        });
        const response = await fetch(`/api/hydrology?${params.toString()}`);
        const payloadValue: unknown = await response.json();
        const errorPayload = payloadValue as { error?: unknown };

        if (!response.ok) {
          throw new Error(
            typeof errorPayload.error === "string"
              ? errorPayload.error
              : `Hydrology API returned ${response.status}`
          );
        }
        if (
          !validateHydrologyResponse(
            payloadValue,
            selectedHydrologyScope,
            selectedHydrologyCode,
            selectedHydrologyBounds,
            selectedHydrologyBoundaryParts,
            HYDROLOGY_RESPONSE_STALE_AFTER_MS
          )
        ) {
          throw new Error("Hydrology API returned an invalid OpenStreetMap dataset.");
        }
        if (requestId !== hydrologyRequestIdRef.current) return;

        applyPayload(payloadValue, "network");
        writeHydrologyCacheEntry(cacheKey, payloadValue);
      } catch (err) {
        if (requestId !== hydrologyRequestIdRef.current) return;

        if (cachedPayload) {
          setHydrologyStatus("ready");
          setHydroError("Live OpenStreetMap refresh failed; the previously validated browser cache remains visible.");
          setStatus("Showing validated cached OpenStreetMap water features.");
        } else {
          setHydrologyStatus("error");
          setHydroError((err as Error).message || "Failed to load GIS water layers for the selected area.");
        }
      }
    },
    [
      areaPickerLabel,
      selectedAreaKey,
      selectedHydrologyBoundary,
      selectedHydrologyBoundaryParts,
      selectedHydrologyBounds,
      selectedHydrologyCode,
      selectedHydrologyScope
    ]
  );

  const fetchWeather = useCallback(
    async (lat: number, lng: number, reason: WeatherSyncReason = "automatic") => {
      const requestId = ++weatherRequestIdRef.current;
      weatherLastRequestAtRef.current = Date.now();

      setIsWeatherRefreshing(true);
      setWeatherError(null);
      setStatus(reason === "initial" ? "Loading weather-model data..." : "Synchronizing weather-model data...");

      try {
        const params = new URLSearchParams({
          latitude: lat.toString(),
          longitude: lng.toString()
        });
        const response = await fetch(`/api/weather?${params.toString()}`);
        const payload = (await response.json()) as WeatherResponse & { error?: string };

        if (!response.ok) {
          throw new Error(payload.error || `Weather service returned ${response.status}`);
        }

        const hasValidHourlyTimes =
          Array.isArray(payload.hourly?.time) &&
          payload.hourly.time.every(
            (time, index, times) =>
              typeof time === "string" &&
              Number.isFinite(new Date(`${time}Z`).valueOf()) &&
              (index === 0 || time > times[index - 1])
          );
        const hasValidWeatherPayload =
          hasValidHourlyTimes &&
          Array.isArray(payload.hourly?.precipitation) &&
          Array.isArray(payload.hourly?.wind_speed_10m) &&
          Array.isArray(payload.hourly?.wind_direction_10m) &&
          payload.hourly.time.length > 0 &&
          payload.hourly.time.length === payload.hourly.precipitation.length &&
          payload.hourly.time.length === payload.hourly.wind_speed_10m.length &&
          payload.hourly.time.length === payload.hourly.wind_direction_10m.length &&
          payload.hourly.precipitation.every((value) => Number.isFinite(value) && value >= 0) &&
          payload.hourly.wind_speed_10m.every((value) => Number.isFinite(value) && value >= 0) &&
          payload.hourly.wind_direction_10m.every(
            (value) => Number.isFinite(value) && value >= 0 && value <= 360
          ) &&
          Number.isFinite(payload.current?.precipitation) &&
          payload.current.precipitation >= 0 &&
          Number.isFinite(payload.current?.wind_speed_10m) &&
          payload.current.wind_speed_10m >= 0 &&
          Number.isFinite(payload.current?.wind_direction_10m) &&
          payload.current.wind_direction_10m >= 0 &&
          payload.current.wind_direction_10m <= 360 &&
          Number.isFinite(payload.current?.interval) &&
          payload.current.interval! > 0 &&
          payload.current.interval! <= 3600 &&
          Number.isFinite(payload.current?.temperature_2m) &&
          Number.isInteger(payload.current?.weather_code) &&
          payload.current.weather_code >= 0 &&
          payload.current.weather_code <= 99 &&
          typeof payload.current?.time === "string" &&
          Number.isFinite(new Date(`${payload.current.time}Z`).valueOf()) &&
          Number.isFinite(payload.elevation) &&
          Number.isFinite(payload.latitude) &&
          Number.isFinite(payload.longitude) &&
          Number.isFinite(payload.utc_offset_seconds) &&
          typeof payload.timezone === "string" &&
          payload.timezone.length > 0 &&
          payload.current_units?.precipitation === "mm" &&
          payload.current_units?.temperature_2m === "°C" &&
          payload.current_units?.weather_code === "wmo code" &&
          payload.current_units?.wind_speed_10m === "km/h" &&
          payload.current_units?.wind_direction_10m === "°" &&
          payload.current_units?.time === "iso8601" &&
          payload.hourly_units?.precipitation === "mm" &&
          payload.hourly_units?.wind_speed_10m === "km/h" &&
          payload.hourly_units?.wind_direction_10m === "°" &&
          payload.hourly_units?.time === "iso8601" &&
          payload._provenance?.provider === DATA_SOURCES.weather.name &&
          payload._provenance?.documentation_url === DATA_SOURCES.weather.documentationUrl &&
          payload._provenance?.dataset === "best_match numerical weather forecast" &&
          Number.isFinite(new Date(payload._provenance?.served_at).valueOf()) &&
          Number.isFinite(payload._provenance?.requested_coordinates?.latitude) &&
          Number.isFinite(payload._provenance?.requested_coordinates?.longitude) &&
          Math.abs(payload._provenance.requested_coordinates.latitude - lat) < 1e-9 &&
          Math.abs(payload._provenance.requested_coordinates.longitude - lng) < 1e-9;

        if (!hasValidWeatherPayload) {
          throw new Error("Weather service returned invalid or incompatible model data.");
        }

        if (requestId !== weatherRequestIdRef.current) return;

        const previousWeather = weatherRef.current;
        const previousSelectedHour = forecastHourRef.current;
        const previousCurrentHour = previousWeather
          ? findClosestTimeIndex(previousWeather.hourly.time, previousWeather.current.time)
          : 0;
        const selectedTime =
          previousWeather && previousSelectedHour !== previousCurrentHour
            ? previousWeather.hourly.time[previousSelectedHour]
            : payload.current.time;
        const nextForecastHour = findClosestTimeIndex(payload.hourly.time, selectedTime || payload.current.time);
        const updatedAt = new Date(payload._provenance.served_at).valueOf();

        forecastHourRef.current = nextForecastHour;
        weatherRef.current = payload;
        lastWeatherUpdatedAtRef.current = updatedAt;
        setForecastHour(nextForecastHour);
        if (reason === "initial" || reason === "area") {
          setIsTimelinePlaying(false);
        }
        setWeather(payload);
        setLastWeatherUpdatedAt(updatedAt);
        setStatus(`Weather-model data synchronized at ${new Date(updatedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit"
        })}.`);
      } catch (err) {
        if (requestId !== weatherRequestIdRef.current) return;

        const message = (err as Error).message || "Failed to refresh weather-model data.";
        setWeatherError(message);
        setStatus(weatherRef.current ? "Weather-model refresh delayed; showing the latest available data." : message);
      } finally {
        if (requestId === weatherRequestIdRef.current) {
          setIsWeatherRefreshing(false);
        }
      }
    },
    []
  );

  const fetchOfficialRainfall = useCallback(async () => {
    const requestId = ++officialRainfallRequestIdRef.current;
    setIsOfficialRainfallRefreshing(true);
    setOfficialRainfallError(null);

    try {
      const response = await fetch("/api/rainfall-observations", { cache: "no-store" });
      const payload = (await response.json()) as OfficialRainfallResponse & { error?: string };

      if (!response.ok) {
        throw new Error(payload.error || `Official rainfall service returned ${response.status}`);
      }

      const hasValidStations =
        Array.isArray(payload.stations) &&
        payload.stations.length > 0 &&
        payload.stations.every(
          (station) =>
            /^\d+$/.test(station.site_id) &&
            typeof station.site_name === "string" &&
            /\bAlbay\b/i.test(station.site_name) &&
            (station.hourly_rain_mm === null ||
              (Number.isFinite(station.hourly_rain_mm) && station.hourly_rain_mm >= 0)) &&
            (station.elevation_m === null || (Number.isFinite(station.elevation_m) && station.elevation_m >= 0)) &&
            (station.observed_at === null || Number.isFinite(new Date(station.observed_at).valueOf())) &&
            ["current", "stale", "unavailable"].includes(station.freshness)
        );
      const hasValidPayload =
        payload.provider === DATA_SOURCES.officialRainfall.name &&
        payload.source_url === DATA_SOURCES.officialRainfall.endpoint &&
        payload.station_scope === "Albay" &&
        payload.period === "preceding hour" &&
        payload.unit === "mm" &&
        Number.isFinite(new Date(payload.retrieved_at).valueOf()) &&
        Number.isFinite(payload.freshness_threshold_minutes) &&
        payload.freshness_threshold_minutes > 0 &&
        payload.freshness_threshold_minutes <= 180 &&
        hasValidStations;

      if (!hasValidPayload) {
        throw new Error("Official rainfall service returned invalid or incompatible station data.");
      }

      if (requestId !== officialRainfallRequestIdRef.current) return;
      setOfficialRainfall(payload);
    } catch (observationError) {
      if (requestId !== officialRainfallRequestIdRef.current) return;
      setOfficialRainfallError(
        (observationError as Error).message || "Failed to refresh official PAGASA rain-gauge observations."
      );
    } finally {
      if (requestId === officialRainfallRequestIdRef.current) {
        setIsOfficialRainfallRefreshing(false);
      }
    }
  }, []);

  const initializeMap = useCallback((initialLocation: FocusLocation) => {
    if (!mapContainerRef.current || mapRef.current) return;
    if (!mapToken) {
      setError("Missing NEXT_PUBLIC_MAPBOX_TOKEN in your environment.");
      return;
    }

    mapboxgl.accessToken = mapToken;
    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/standard-satellite",
      config: {
        basemap: {
          lightPreset: "day",
          showPointOfInterestLabels: false,
          showPlaceLabels: true,
          showRoadLabels: true,
          showRoadsAndTransit: true
        }
      },
      center: [initialLocation.lng, initialLocation.lat],
      zoom: 11,
      pitch: 58,
      bearing: -18,
      projection: "mercator",
      maxPitch: 80,
      antialias: true
    });

    mapRef.current = map;
    map.addControl(new mapboxgl.NavigationControl({ visualizePitch: true }), "top-right");
    map.on("load", () => {
      map.setCenter([initialLocation.lng, initialLocation.lat]);

      if (!map.getSource("flood-terrain-dem")) {
        map.addSource("flood-terrain-dem", {
          type: "raster-dem",
          url: "mapbox://mapbox.mapbox-terrain-dem-v1",
          tileSize: 512,
          maxzoom: 14
        });
      }

      map.setTerrain({ source: "flood-terrain-dem", exaggeration: 1 });
      map.setFog({
        range: [0.6, 9],
        color: "#dce9e4",
        "high-color": "#8aa9b8",
        "space-color": "#08100e",
        "horizon-blend": 0.12
      });

      map.addSource("rain-analysis-zone", {
        type: "geojson",
        data: toFeatureCollection() as FeatureCollection
      });

      map.addLayer({
        id: "zone-fill",
        type: "fill",
        source: "rain-analysis-zone",
        slot: "middle",
        paint: {
          "fill-color": RAIN_ANALYSIS_ZONE_COLOR,
          "fill-opacity": 0.28
        }
      });

      map.addLayer({
        id: "zone-outline",
        type: "line",
        source: "rain-analysis-zone",
        slot: "middle",
        paint: {
          "line-color": RAIN_ANALYSIS_ZONE_COLOR,
          "line-width": 2
        }
      });

      map.addSource("albay-barangays", {
        type: "geojson",
        data: toBarangayFeatureCollection()
      });

      map.addLayer({
        id: "barangay-selected-fill",
        type: "fill",
        source: "albay-barangays",
        slot: "middle",
        filter: ["==", ["get", "code"], "__none__"],
        paint: {
          "fill-color": "#f3cf65",
          "fill-opacity": 0.3
        }
      });

      map.addLayer({
        id: "barangay-boundaries-line",
        type: "line",
        source: "albay-barangays",
        slot: "middle",
        paint: {
          "line-color": "#f7f5ef",
          "line-opacity": 0.72,
          "line-width": 1
        }
      });

      map.addLayer({
        id: "barangay-selected-outline",
        type: "line",
        source: "albay-barangays",
        slot: "middle",
        filter: ["==", ["get", "code"], "__none__"],
        paint: {
          "line-color": "#ffd65a",
          "line-opacity": 1,
          "line-width": 3
        }
      });

      map.addSource("water-network", {
        type: "geojson",
        data: toFeatureCollection() as FeatureCollection
      });

      map.addLayer({
        id: "water-network-line",
        type: "line",
        source: "water-network",
        slot: "middle",
        filter: [
          "any",
          ["==", ["geometry-type"], "LineString"],
          ["==", ["geometry-type"], "MultiLineString"]
        ],
        paint: {
          "line-color": "#3a5c84",
          "line-width": 2.8,
          "line-opacity": 0.9
        }
      });

      map.addLayer({
        id: "water-network-fill",
        type: "fill",
        source: "water-network",
        slot: "middle",
        filter: ["any", ["==", ["geometry-type"], "Polygon"], ["==", ["geometry-type"], "MultiPolygon"]],
        paint: {
          "fill-color": "#9eb6d1",
          "fill-opacity": 0.23
        }
      });

      map.addLayer({
        id: "water-network-outline",
        type: "line",
        source: "water-network",
        slot: "middle",
        filter: ["any", ["==", ["geometry-type"], "Polygon"], ["==", ["geometry-type"], "MultiPolygon"]],
        paint: {
          "line-color": "#3a5c84",
          "line-width": 1.2
        }
      });

      setMapLoaded(true);
      setStatus("3D satellite map loaded. Pulling weather and flood analysis...");
    });

    map.on("error", (event) => {
      if (event && "error" in event) {
        setError(`Map error: ${String((event.error as Error).message || "Unknown")}`);
      }
    });
  }, [mapToken]);

  const updateMapLayers = useCallback(() => {
    const map = mapRef.current;
    if (!map || !analysis || !mapLoaded) return;

    const point: [number, number] = [location.lng, location.lat];
    const zoneSource = map.getSource("rain-analysis-zone") as mapboxgl.GeoJSONSource | undefined;
    const hydroSource = map.getSource("water-network") as mapboxgl.GeoJSONSource | undefined;
    const barangaySource = map.getSource("albay-barangays") as mapboxgl.GeoJSONSource | undefined;

    const sourceData: FeatureCollection<Polygon | Point> = {
      type: "FeatureCollection",
      features: [
        {
          ...analysis.polygon,
          properties: {
            radiusKm: analysis.radiusKm,
            modeledRainMm: analysis.precipWindowMm,
            grossRainfallLiters: analysis.estimatedWaterLiters
          }
        },
        {
          type: "Feature",
          geometry: {
            type: "Point",
            coordinates: point
          },
          properties: {
            label: location.label,
            type: selectedBarangay ? "barangay-focus" : selectedMunicipality ? "municipality-focus" : "province-focus"
          }
        } as Feature<Point>
      ]
    };

    if (zoneSource) {
      zoneSource.setData(sourceData);
    }

    if (hydroSource) {
      hydroSource.setData(hydroData);
    }

    if (barangaySource) {
      barangaySource.setData(barangayData);
    }

    ["barangay-selected-fill", "barangay-selected-outline"].forEach((layerId) => {
      if (map.getLayer(layerId)) {
        map.setFilter(layerId, selectedBoundaryFilter);
      }
    });

    if (!markerRef.current) {
      markerRef.current = new mapboxgl.Marker({ color: "#0d1112" }).setLngLat(point).addTo(map);
    } else {
      markerRef.current.setLngLat(point);
    }

    const popup = new mapboxgl.Popup({ closeButton: false, closeOnClick: false })
      .setLngLat(point)
      .setHTML(
        `<div class="district-forward-popup">
          <div><strong>Area:</strong> ${location.label}</div>
          <div><strong>Current model weather:</strong> ${weather ? getWeatherLabel(weather.current.weather_code) : "Unavailable"}</div>
          <div><strong>Current model temperature:</strong> ${weather ? `${formatNumber(weather.current.temperature_2m, 1)} ${weather.current_units.temperature_2m}` : "Unavailable"}</div>
          <div class="popup-detail"><strong>Modeled window rain:</strong> ${formatNumber(
            analysis.precipWindowMm,
            1
          )} ${weather?.current_units.precipitation ?? "mm"}</div>
          <div class="popup-detail"><strong>Avg selected rain rate:</strong> ${formatNumber(analysis.selectedRainRateMmPerHour, 1)} mm/h</div>
          <div class="popup-detail"><strong>Selected 10 m wind:</strong> ${formatNumber(
            analysis.selectedWindSpeedKph,
            1
          )} km/h from ${formatWindDirection(analysis.selectedWindDirectionDegrees)}</div>
          <div class="popup-detail"><strong>Window:</strong> ${formatTime(analysis.windowStartTime)} → ${formatTime(
            analysis.windowEndTime
          )}</div>
          <div class="popup-detail"><strong>Selected hour:</strong> ${formatTime(weather?.hourly.time[safeForecastHour] ?? "")}</div>
        </div>`
      );
    map.getCanvas().style.cursor = "default";
    const markerWithPopup = markerRef.current;
    if (markerWithPopup) {
      markerWithPopup.setPopup(popup);
      popup.addTo(map);
    }

    const nextFitKey = `${selectedAreaKey}:${radiusKm}`;
    if (lastMapFitRef.current !== nextFitKey) {
      lastMapFitRef.current = nextFitKey;
      const focusFeature = selectedAreaGeoJson ?? analysis.polygon;
      map.fitBounds(turf.bbox(focusFeature) as [number, number, number, number], {
        padding: selectedBarangay ? 56 : selectedMunicipality ? 44 : 36,
        maxZoom: selectedBarangay ? 15.5 : selectedMunicipality ? 12.5 : 9.5,
        pitch: 58,
        bearing: -18,
        duration: 900
      });
    }
  }, [
    analysis,
    barangayData,
    formatTime,
    getWeatherLabel,
    weather?.current.weather_code,
    weather?.current.temperature_2m,
    weather?.current_units.temperature_2m,
    weather?.hourly.time,
    hydroData,
    location,
    mapLoaded,
    safeForecastHour,
    selectedAreaGeoJson,
    selectedAreaKey,
    selectedBarangay,
    selectedBarangayCode,
    selectedBoundaryFilter,
    selectedMunicipality,
    formatNumber,
    radiusKm
  ]);

  const resetFocusView = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    lastMapFitRef.current = `${selectedAreaKey}:${radiusKm}`;
    const focusFeature = selectedAreaGeoJson ?? analysis?.polygon;
    if (focusFeature) {
      map.fitBounds(turf.bbox(focusFeature) as [number, number, number, number], {
        padding: selectedBarangay ? 56 : selectedMunicipality ? 44 : 36,
        maxZoom: selectedBarangay ? 15.5 : selectedMunicipality ? 12.5 : 9.5,
        pitch: 58,
        bearing: -18,
        duration: 900
      });
      return;
    }

    map.flyTo({
      center: [location.lng, location.lat],
      zoom: 10.5,
      pitch: 58,
      bearing: -18,
      duration: 900
    });
  }, [analysis, location, radiusKm, selectedAreaGeoJson, selectedAreaKey, selectedBarangay, selectedMunicipality]);

  useEffect(() => {
    const controller = new AbortController();

    const loadBarangayBoundaries = async () => {
      try {
        const response = await fetch("/albay-barangays.geojson", { signal: controller.signal });
        if (!response.ok) {
          throw new Error(`Barangay boundary file returned ${response.status}`);
        }

        const collection = validateAndNormalizeBarangayData(await response.json());

        setBarangayData(collection);
        setBarangayError(null);
      } catch (boundaryError) {
        if ((boundaryError as Error).name === "AbortError") return;
        setBarangayError((boundaryError as Error).message || "Failed to load Albay barangay boundaries.");
      }
    };

    void loadBarangayBoundaries();
    return () => controller.abort();
  }, []);

  useEffect(() => {
    if (barangayData.features.length === 0) return;

    const focusKey = selectedAreaKey;
    if (weatherFocusKeyRef.current === focusKey) return;

    const reason: WeatherSyncReason = weatherFocusKeyRef.current === null ? "initial" : "area";
    weatherFocusKeyRef.current = focusKey;
    setStatus(`Updating rainfall and GIS data for ${location.label}...`);
    void fetchWeather(location.lat, location.lng, reason);
  }, [barangayData.features.length, fetchWeather, location, selectedAreaKey]);

  useEffect(() => {
    forecastHourRef.current = forecastHour;
  }, [forecastHour]);

  useEffect(() => {
    setIsOnline(navigator.onLine);
    setClockNow(Date.now());

    const handleOnline = () => setIsOnline(true);
    const handleOffline = () => setIsOnline(false);
    const clock = window.setInterval(() => setClockNow(Date.now()), 30_000);

    window.addEventListener("online", handleOnline);
    window.addEventListener("offline", handleOffline);

    return () => {
      window.clearInterval(clock);
      window.removeEventListener("online", handleOnline);
      window.removeEventListener("offline", handleOffline);
    };
  }, []);

  useEffect(() => {
    const refreshLatestWeather = (reason: WeatherSyncReason, minimumAgeMs = 0) => {
      if (!navigator.onLine) return;

      const lastUpdatedAt = lastWeatherUpdatedAtRef.current;
      const ageMs = lastUpdatedAt ? Date.now() - lastUpdatedAt : Number.POSITIVE_INFINITY;
      const requestRecentlyStarted = Date.now() - weatherLastRequestAtRef.current < 10_000;
      if (ageMs < minimumAgeMs || requestRecentlyStarted) return;

      void fetchWeather(location.lat, location.lng, reason);
    };

    const refreshInterval = window.setInterval(
      () => refreshLatestWeather("automatic", WEATHER_REFRESH_INTERVAL_MS - 1_000),
      WEATHER_REFRESH_INTERVAL_MS
    );
    const handleVisibility = () => {
      setClockNow(Date.now());
      if (document.visibilityState === "visible") {
        refreshLatestWeather("focus", WEATHER_FOCUS_REFRESH_MS);
      }
    };
    const handleFocus = () => refreshLatestWeather("focus", WEATHER_FOCUS_REFRESH_MS);
    const handleReconnect = () => refreshLatestWeather("reconnect");

    document.addEventListener("visibilitychange", handleVisibility);
    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleReconnect);

    return () => {
      window.clearInterval(refreshInterval);
      document.removeEventListener("visibilitychange", handleVisibility);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleReconnect);
    };
  }, [fetchWeather, location]);

  useEffect(() => {
    let lastRequestAt = 0;

    const refreshOfficialRainfall = (minimumAgeMs = 0) => {
      if (!navigator.onLine || Date.now() - lastRequestAt < minimumAgeMs) return;
      lastRequestAt = Date.now();
      void fetchOfficialRainfall();
    };

    refreshOfficialRainfall();
    const refreshInterval = window.setInterval(
      () => refreshOfficialRainfall(WEATHER_REFRESH_INTERVAL_MS - 1_000),
      WEATHER_REFRESH_INTERVAL_MS
    );
    const handleFocus = () => refreshOfficialRainfall(WEATHER_FOCUS_REFRESH_MS);
    const handleReconnect = () => refreshOfficialRainfall();

    window.addEventListener("focus", handleFocus);
    window.addEventListener("online", handleReconnect);

    return () => {
      window.clearInterval(refreshInterval);
      window.removeEventListener("focus", handleFocus);
      window.removeEventListener("online", handleReconnect);
      officialRainfallRequestIdRef.current += 1;
    };
  }, [fetchOfficialRainfall]);

  useEffect(() => {
    if (barangayData.features.length === 0) return;
    initializeMap(location);
  }, [barangayData.features.length, initializeMap, location]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const resizeFrame = window.requestAnimationFrame(() => map.resize());
    const resizeAfterTransition = window.setTimeout(() => map.resize(), 280);

    return () => {
      window.cancelAnimationFrame(resizeFrame);
      window.clearTimeout(resizeAfterTransition);
    };
  }, [isReadingsPanelOpen, mapLoaded]);

  useEffect(() => {
    return () => {
      if (markerRef.current) {
        markerRef.current.remove();
        markerRef.current = null;
      }

      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || !albayProvinceBounds) return;

    const applyResponsiveAlbayBounds = () => {
      const [west, south, east, north] = albayProvinceBounds;
      const provinceWidth = east - west;
      const provinceHeight = north - south;
      const container = map.getContainer();
      const viewportAspect = Math.min(3, Math.max(0.5, container.clientWidth / Math.max(1, container.clientHeight)));
      const paddedWidth = provinceWidth * (1 + ALBAY_MAP_BOUNDS_PADDING_RATIO * 2);
      const paddedHeight = provinceHeight * (1 + ALBAY_MAP_BOUNDS_PADDING_RATIO * 2);
      const viewportWidth = provinceHeight * viewportAspect * ALBAY_VIEWPORT_FOOTPRINT_ALLOWANCE;
      const viewportHeight = (provinceWidth / viewportAspect) * ALBAY_VIEWPORT_FOOTPRINT_ALLOWANCE;
      const boundaryWidth = Math.max(paddedWidth, viewportWidth);
      const boundaryHeight = Math.max(paddedHeight, viewportHeight);
      const centerLongitude = (west + east) / 2;
      const centerLatitude = (south + north) / 2;
      const responsiveBounds: mapboxgl.LngLatBoundsLike = [
        [centerLongitude - boundaryWidth / 2, centerLatitude - boundaryHeight / 2],
        [centerLongitude + boundaryWidth / 2, centerLatitude + boundaryHeight / 2]
      ];

      map.setMaxBounds(responsiveBounds);
    };

    applyResponsiveAlbayBounds();
    map.on("resize", applyResponsiveAlbayBounds);

    return () => {
      map.off("resize", applyResponsiveAlbayBounds);
    };
  }, [albayProvinceBounds, mapLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const source = map.getSource("albay-barangays") as mapboxgl.GeoJSONSource | undefined;
    source?.setData(barangayData);

    ["barangay-selected-fill", "barangay-selected-outline"].forEach((layerId) => {
      if (map.getLayer(layerId)) {
        map.setFilter(layerId, selectedBoundaryFilter);
      }
    });

    if (selectedAreaGeoJson) {
      const nextFitKey = `${selectedAreaKey}:${radiusKm}`;
      if (lastMapFitRef.current !== nextFitKey) {
        lastMapFitRef.current = nextFitKey;
        map.fitBounds(turf.bbox(selectedAreaGeoJson) as [number, number, number, number], {
          padding: selectedBarangay ? 56 : selectedMunicipality ? 44 : 36,
          maxZoom: selectedBarangay ? 15.5 : selectedMunicipality ? 12.5 : 9.5,
          pitch: 58,
          bearing: -18,
          duration: 900
        });
      }
    }
  }, [
    barangayData,
    mapLoaded,
    radiusKm,
    selectedAreaGeoJson,
    selectedAreaKey,
    selectedBarangay,
    selectedBoundaryFilter,
    selectedMunicipality
  ]);

  useEffect(() => {
    if (!weather) return;
    updateMapLayers();
  }, [weather, analysis, mapLoaded, radiusKm, safeHours, safeForecastHour, hydroData, updateMapLayers]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const setVisibility = (layerIds: string[], visible: boolean) => {
      layerIds.forEach((layerId) => {
        if (map.getLayer(layerId)) {
          map.setLayoutProperty(layerId, "visibility", visible ? "visible" : "none");
        }
      });
    };

    setVisibility(["zone-fill", "zone-outline"], layerVisibility.rainZone);
    setVisibility(
      ["barangay-selected-fill", "barangay-boundaries-line", "barangay-selected-outline"],
      layerVisibility.barangays
    );
    setVisibility(["water-network-line"], layerVisibility.waterways);
    setVisibility(["water-network-fill", "water-network-outline"], layerVisibility.waterAreas);
  }, [layerVisibility, mapLoaded]);

  useEffect(() => {
    const canvas = rainCanvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const map = mapRef.current;
    const activeAnalysis = analysis;
    const rainClipGeometries: Array<Polygon | MultiPolygon> = selectedAreaGeoJson
      ? selectedAreaGeoJson.type === "FeatureCollection"
        ? selectedAreaGeoJson.features.map((feature) => feature.geometry)
        : [selectedAreaGeoJson.geometry]
      : activeAnalysis
        ? [activeAnalysis.polygon.geometry]
        : [];
    const rainClipRings = rainClipGeometries.flatMap((geometry) =>
      geometry.type === "Polygon" ? geometry.coordinates : geometry.coordinates.flat()
    );

    if (!map || !mapLoaded || !activeAnalysis || rainClipRings.length === 0) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const rainMm = activeAnalysis.selectedRainRateMmPerHour;
    const measuredRainMm = Math.max(0, rainMm);
    const rainStrength = Math.min(1, measuredRainMm / 8);
    const baseFallSpeed = 90 + Math.min(measuredRainMm, 12) * 16;
    const windSpeedKph = Math.max(0, activeAnalysis.selectedWindSpeedKph);
    const downwindBearing = (activeAnalysis.selectedWindDirectionDegrees + 180) % 360;
    const windPushPixelsPerSecond = Math.min(140, windSpeedKph * 2.25);
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let particles: RainParticle[] = [];
    let animationFrame = 0;
    let previousTime = performance.now();
    let rainClipPath: Path2D | null = null;
    let rainClipScreenRings: Array<Array<{ x: number; y: number }>> = [];
    let rainClipBounds: { minX: number; minY: number; maxX: number; maxY: number } | null = null;
    let windVelocity = { x: 0, y: 0 };

    const updateWindVelocity = () => {
      if (windPushPixelsPerSecond <= 0) {
        windVelocity = { x: 0, y: 0 };
        return;
      }

      const center = map.getCenter();
      const downwindPoint = turf.destination(turf.point([center.lng, center.lat]), 1, downwindBearing, {
        units: "kilometers"
      });
      const destination = downwindPoint.geometry.coordinates;
      const originOnScreen = map.project([center.lng, center.lat]);
      const destinationOnScreen = map.project(destination as [number, number]);
      const vectorX = destinationOnScreen.x - originOnScreen.x;
      const vectorY = destinationOnScreen.y - originOnScreen.y;
      const vectorLength = Math.hypot(vectorX, vectorY);

      windVelocity =
        vectorLength > 0
          ? {
              x: (vectorX / vectorLength) * windPushPixelsPerSecond,
              y: (vectorY / vectorLength) * windPushPixelsPerSecond
            }
          : { x: 0, y: 0 };
    };

    const isPointInRainClip = (x: number, y: number) => {
      let inside = false;

      rainClipScreenRings.forEach((ring) => {
        for (let index = 0, previousIndex = ring.length - 1; index < ring.length; previousIndex = index++) {
          const current = ring[index];
          const previous = ring[previousIndex];
          const crossesRay =
            current.y > y !== previous.y > y &&
            x < ((previous.x - current.x) * (y - current.y)) / (previous.y - current.y) + current.x;

          if (crossesRay) inside = !inside;
        }
      });

      return inside;
    };

    const getRandomPointInRainClip = () => {
      const bounds = rainClipBounds;
      if (!bounds) return { x: width / 2, y: height / 2 };

      const boundsWidth = Math.max(1, bounds.maxX - bounds.minX);
      const boundsHeight = Math.max(1, bounds.maxY - bounds.minY);

      for (let attempt = 0; attempt < 160; attempt += 1) {
        const x = bounds.minX + Math.random() * boundsWidth;
        const y = bounds.minY + Math.random() * boundsHeight;
        if (isPointInRainClip(x, y)) return { x, y };
      }

      // A projected boundary vertex is a safe visual fallback for unusually
      // narrow polygons where random rejection sampling may miss the interior.
      const fallback = rainClipScreenRings.find((ring) => ring.length > 0)?.[0];
      return fallback ?? { x: width / 2, y: height / 2 };
    };

    const createParticle = (): RainParticle => {
      const point = getRandomPointInRainClip();

      return {
        x: point.x,
        y: point.y,
        radius: 0.8 + rainStrength * 1.1 + Math.random() * 0.9,
        speed: baseFallSpeed * (0.82 + Math.random() * 0.36),
        windResponse: 0.82 + Math.random() * 0.36,
        turbulence: -4 + Math.random() * 8,
        opacity: 0.4 + Math.random() * 0.55
      };
    };

    const updateRainClipPath = () => {
      const path = new Path2D();
      const screenRings: Array<Array<{ x: number; y: number }>> = [];
      let minX = Number.POSITIVE_INFINITY;
      let minY = Number.POSITIVE_INFINITY;
      let maxX = Number.NEGATIVE_INFINITY;
      let maxY = Number.NEGATIVE_INFINITY;

      rainClipRings.forEach((ring) => {
        const screenRing: Array<{ x: number; y: number }> = [];

        ring.forEach((coordinate, index) => {
          const point = map.project(coordinate as [number, number]);
          screenRing.push({ x: point.x, y: point.y });
          minX = Math.min(minX, point.x);
          minY = Math.min(minY, point.y);
          maxX = Math.max(maxX, point.x);
          maxY = Math.max(maxY, point.y);

          if (index === 0) {
            path.moveTo(point.x, point.y);
          } else {
            path.lineTo(point.x, point.y);
          }
        });
        path.closePath();
        screenRings.push(screenRing);
      });

      rainClipPath = path;
      rainClipScreenRings = screenRings;
      updateWindVelocity();

      const visibleMinX = Math.max(0, minX);
      const visibleMinY = Math.max(0, minY);
      const visibleMaxX = Math.min(width, maxX);
      const visibleMaxY = Math.min(height, maxY);
      rainClipBounds =
        Number.isFinite(visibleMinX) &&
        Number.isFinite(visibleMinY) &&
        visibleMaxX > visibleMinX &&
        visibleMaxY > visibleMinY
          ? { minX: visibleMinX, minY: visibleMinY, maxX: visibleMaxX, maxY: visibleMaxY }
          : null;
    };

    const resetParticles = () => {
      const bounds = rainClipBounds;
      if (!bounds || measuredRainMm <= 0) {
        particles = [];
        return;
      }

      const clipPixelArea = (bounds.maxX - bounds.minX) * (bounds.maxY - bounds.minY);
      const areaScale = Math.max(0.65, Math.min(1.35, clipPixelArea / 160000));
      // Positive modeled rain always gets a small visible minimum. Density,
      // size, and fall speed still increase with the actual selected rate.
      const count = Math.min(180, Math.max(12, Math.round(measuredRainMm * 40 * areaScale)));
      particles = Array.from({ length: count }, createParticle);
    };

    const drawParticles = () => {
      context.clearRect(0, 0, width, height);
      if (!rainClipPath) return;

      context.save();
      context.clip(rainClipPath, "evenodd");
      context.shadowColor = "rgba(38, 255, 124, 0.62)";
      context.shadowBlur = 5;

      particles.forEach((particle) => {
        context.beginPath();
        context.fillStyle = `rgba(45, 220, 114, ${particle.opacity})`;
        context.arc(particle.x, particle.y, particle.radius, 0, Math.PI * 2);
        context.fill();
      });

      context.shadowBlur = 0;
      context.restore();
    };

    const resize = () => {
      const bounds = host.getBoundingClientRect();
      width = Math.max(1, bounds.width);
      height = Math.max(1, bounds.height);
      const pixelRatio = Math.min(window.devicePixelRatio || 1, 2);
      canvas.width = Math.round(width * pixelRatio);
      canvas.height = Math.round(height * pixelRatio);
      canvas.style.width = `${width}px`;
      canvas.style.height = `${height}px`;
      context.setTransform(pixelRatio, 0, 0, pixelRatio, 0, 0);
      updateRainClipPath();
      resetParticles();
      drawParticles();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    const handleMapTransform = () => {
      updateRainClipPath();
      if (reduceMotion) drawParticles();
    };

    const handleMapTransformEnd = () => {
      updateRainClipPath();
      resetParticles();
      drawParticles();
    };

    map.on("move", handleMapTransform);
    map.on("resize", handleMapTransform);
    map.on("moveend", handleMapTransformEnd);

    if (!layerVisibility.rainAnimation || measuredRainMm <= 0 || reduceMotion) {
      if (!layerVisibility.rainAnimation || measuredRainMm <= 0) {
        context.clearRect(0, 0, width, height);
      }
      return () => {
        map.off("move", handleMapTransform);
        map.off("resize", handleMapTransform);
        map.off("moveend", handleMapTransformEnd);
        resizeObserver.disconnect();
        context.clearRect(0, 0, width, height);
      };
    }

    const animateRain = (time: number) => {
      const elapsedSeconds = Math.min(0.04, (time - previousTime) / 1000);
      previousTime = time;

      particles.forEach((particle, index) => {
        const windX = windVelocity.x * particle.windResponse + particle.turbulence;
        const windY = windVelocity.y * particle.windResponse;
        const verticalSpeed = Math.max(particle.speed * 0.35, particle.speed + windY);
        particle.x += windX * elapsedSeconds;
        particle.y += verticalSpeed * elapsedSeconds;

        const bounds = rainClipBounds;
        if (
          !bounds ||
          particle.y > bounds.maxY + 8 ||
          particle.x < bounds.minX - 8 ||
          particle.x > bounds.maxX + 8
        ) {
          particles[index] = createParticle();
        }
      });

      drawParticles();
      animationFrame = window.requestAnimationFrame(animateRain);
    };

    animationFrame = window.requestAnimationFrame(animateRain);

    return () => {
      window.cancelAnimationFrame(animationFrame);
      map.off("move", handleMapTransform);
      map.off("resize", handleMapTransform);
      map.off("moveend", handleMapTransformEnd);
      resizeObserver.disconnect();
      context.clearRect(0, 0, width, height);
    };
  }, [analysis, layerVisibility.rainAnimation, mapLoaded, selectedAreaGeoJson]);

  useEffect(() => {
    if (!selectedHydrologyBoundary || !selectedHydrologyBounds) return;

    hydrologyRequestIdRef.current += 1;
    setHydrologyStatus("idle");
    setHydroData(toFeatureCollection());
    const handle = window.setTimeout(() => {
      fetchHydrology();
    }, 500);

    return () => window.clearTimeout(handle);
  }, [fetchHydrology, selectedAreaKey, selectedHydrologyBoundary, selectedHydrologyBounds]);

  useEffect(() => {
    if (!isTimelinePlaying || !hasWeather) return;

    if (safeForecastHour >= maxForecastHour) {
      setIsTimelinePlaying(false);
      return;
    }

    const handle = window.setTimeout(() => {
      setForecastHour((hour) => Math.min(hour + 1, maxForecastHour));
    }, TIMELINE_FRAME_INTERVAL_MS / timelinePlaybackSpeed);

    return () => window.clearTimeout(handle);
  }, [hasWeather, isTimelinePlaying, maxForecastHour, safeForecastHour, timelinePlaybackSpeed]);

  const selectedForecastTime = hasWeather ? weather!.hourly.time[safeForecastHour] : "";
  const firstTimelineTime = hasWeather ? weather!.hourly.time[0] : "";
  const maxForecastLabel = hasWeather ? weather!.hourly.time[maxForecastHour] : "N/A";
  const currentWeatherHour = weather ? findClosestTimeIndex(weather.hourly.time, weather.current.time) : 0;
  const selectedHourOffset = safeForecastHour - currentWeatherHour;
  const selectedHourPhase =
    selectedHourOffset === 0
      ? "Current hour"
      : selectedHourOffset < 0
        ? `${Math.abs(selectedHourOffset)}h ago`
        : `In ${selectedHourOffset}h`;

  const referenceNow = clockNow ?? lastWeatherUpdatedAt ?? 0;
  const weatherAgeMs = lastWeatherUpdatedAt ? Math.max(0, referenceNow - lastWeatherUpdatedAt) : null;
  const isWeatherStale = weatherAgeMs !== null && weatherAgeMs > WEATHER_STALE_AFTER_MS;
  const getOfficialGaugeState = (station: OfficialRainGaugeStation) => {
    if (station.hourly_rain_mm === null || !station.observed_at) return "unavailable" as const;

    const observedAt = new Date(station.observed_at).valueOf();
    const thresholdMinutes = officialRainfall?.freshness_threshold_minutes ?? 60;
    const ageMs = referenceNow - observedAt;
    return Number.isFinite(observedAt) && ageMs >= -15 * 60_000 && ageMs <= thresholdMinutes * 60_000
      ? "current" as const
      : "stale" as const;
  };
  const featuredOfficialGauge = officialRainfall
    ? [...officialRainfall.stations]
        .filter((station) => station.hourly_rain_mm !== null && station.observed_at !== null)
        .sort(
          (a, b) => new Date(b.observed_at!).valueOf() - new Date(a.observed_at!).valueOf()
        )[0] ?? officialRainfall.stations[0]
    : null;
  const featuredOfficialGaugeState = featuredOfficialGauge
    ? getOfficialGaugeState(featuredOfficialGauge)
    : "unavailable";
  const latestError = error || weatherError || officialRainfallError || hydroError || barangayError;
  const currentRainIntervalMinutes = Math.max(1, Math.round((weather?.current.interval ?? 3600) / 60));
  const selectedRainRateBasis =
    selectedHourOffset === 0
      ? `Equivalent hourly rate derived from the current ${currentRainIntervalMinutes}-minute modeled precipitation`
      : "Average rate derived from Open-Meteo's preceding-hour precipitation total";
  const formatRelativeAge = (timestamp: number | null) => {
    if (!timestamp || !referenceNow) return "Waiting for first sync";

    const elapsedSeconds = Math.max(0, Math.floor((referenceNow - timestamp) / 1000));
    if (elapsedSeconds < 15) return "Updated just now";
    if (elapsedSeconds < 60) return `Updated ${elapsedSeconds}s ago`;

    const elapsedMinutes = Math.floor(elapsedSeconds / 60);
    if (elapsedMinutes < 60) return `Updated ${elapsedMinutes}m ago`;
    return `Updated ${Math.floor(elapsedMinutes / 60)}h ago`;
  };
  const liveFeedState = !isOnline
    ? "offline"
    : isWeatherRefreshing
      ? "syncing"
      : weatherError || isWeatherStale
        ? "stale"
        : weather
          ? "live"
          : "connecting";
  const liveFeedLabel = !isOnline
    ? "Offline"
    : isWeatherRefreshing
      ? "Syncing"
      : weatherError
        ? "Refresh delayed"
        : isWeatherStale
          ? "Data stale"
          : weather
          ? "Model data"
            : "Connecting";
  const nextSyncMinutes = lastWeatherUpdatedAt
    ? Math.max(0, Math.ceil((lastWeatherUpdatedAt + WEATHER_REFRESH_INTERVAL_MS - referenceNow) / 60_000))
    : null;

  const loadingStage = barangayData.features.length === 0 && !barangayError
    ? 0
    : !weather
      ? 1
      : !mapLoaded
        ? 2
        : hydrologyStatus === "idle" || hydrologyStatus === "loading"
          ? 3
          : 4;
  const loadingBlocked = Boolean((error || weatherError || barangayError) && (!weather || !mapLoaded));
  const isInitialLoading = !hasFinishedInitialLoad && !loadingBlocked;
  const activeLoadingStage = INITIAL_LOADING_STEPS[loadingStage] ?? READY_LOADING_STAGE;
  const loadingProgress = Math.round((loadingStage / INITIAL_LOADING_STEPS.length) * 100);

  useEffect(() => {
    if (loadingStage !== INITIAL_LOADING_STEPS.length || hasFinishedInitialLoad) return;

    const handle = window.setTimeout(() => {
      setHasFinishedInitialLoad(true);
    }, 420);

    return () => window.clearTimeout(handle);
  }, [hasFinishedInitialLoad, loadingStage]);

  return (
    <main className="district-forward-page">
      <section
        className="district-forward-shell"
        aria-label="Source-backed rainfall and hydrology dashboard"
        aria-busy={isInitialLoading}
      >
        {isInitialLoading ? (
          <div
            className={`district-loading-overlay${loadingStage === INITIAL_LOADING_STEPS.length ? " is-complete" : ""}`}
            role="status"
            aria-live="polite"
            aria-atomic="true"
          >
            <div className="district-loading-panel">
              <div className="district-loading-radar">
                <FloodLoadingIcon />
              </div>

              <div className="district-loading-message">
                <p>Source-backed rainfall data</p>
                <h2>{activeLoadingStage.title}</h2>
                <span>{activeLoadingStage.detail}</span>
              </div>

              <div
                className="district-loading-progress"
                role="progressbar"
                aria-label="Dashboard loading progress"
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={loadingProgress}
              >
                <span style={{ width: `${loadingProgress}%` }} />
              </div>

              <ol className="district-loading-stages" aria-label="Loading stages">
                {INITIAL_LOADING_STEPS.map((step, index) => {
                  const className =
                    index < loadingStage ? "is-complete" : index === loadingStage ? "is-active" : undefined;

                  return (
                    <li key={step.label} className={className}>
                      <span aria-hidden="true">{index < loadingStage ? "✓" : String(index + 1).padStart(2, "0")}</span>
                      {step.label}
                    </li>
                  );
                })}
              </ol>
            </div>
          </div>
        ) : null}

        {isAreaPickerOpen ? (
          <div
            className="area-search-backdrop"
            onMouseDown={(event) => {
              if (event.target === event.currentTarget) closeAreaPicker();
            }}
          >
            <section className="area-search-dialog" role="dialog" aria-modal="true" aria-labelledby="area-search-title">
              <header className="area-search-header">
                <div>
                  <span>Albay coverage</span>
                  <h2 id="area-search-title">Find an area</h2>
                  <p>
                    Search {municipalityOptions.length} cities and municipalities or {barangayData.features.length} barangays.
                  </p>
                </div>
                <button type="button" onClick={() => closeAreaPicker()} aria-label="Close area search">
                  ×
                </button>
              </header>

              <div className="area-search-input-wrap">
                <span className="area-search-icon" aria-hidden="true" />
                <input
                  ref={areaSearchInputRef}
                  type="search"
                  role="combobox"
                  aria-autocomplete="list"
                  aria-expanded="true"
                  aria-controls="area-search-results"
                  aria-label="Search Albay cities, municipalities, and barangays"
                  aria-activedescendant={
                    areaOptions[activeAreaOptionIndex] ? `area-option-${activeAreaOptionIndex}` : undefined
                  }
                  placeholder="Search all Albay areas…"
                  value={areaSearchQuery}
                  onChange={(event) => {
                    setAreaSearchQuery(event.target.value);
                    setActiveAreaOptionIndex(0);
                  }}
                  onKeyDown={(event) => {
                    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
                      event.preventDefault();
                      const direction = event.key === "ArrowDown" ? 1 : -1;
                      const nextIndex = Math.min(
                        Math.max(activeAreaOptionIndex + direction, 0),
                        Math.max(areaOptions.length - 1, 0)
                      );
                      setActiveAreaOptionIndex(nextIndex);
                      window.requestAnimationFrame(() =>
                        document.getElementById(`area-option-${nextIndex}`)?.scrollIntoView({ block: "nearest" })
                      );
                    }

                    if (event.key === "Enter" && areaOptions[activeAreaOptionIndex]) {
                      event.preventDefault();
                      selectAreaOption(areaOptions[activeAreaOptionIndex]);
                    }
                  }}
                />
                {areaSearchQuery ? (
                  <button
                    type="button"
                    className="area-search-clear"
                    onClick={() => {
                      setAreaSearchQuery("");
                      setActiveAreaOptionIndex(0);
                      areaSearchInputRef.current?.focus();
                    }}
                    aria-label="Clear area search"
                  >
                    Clear
                  </button>
                ) : null}
              </div>

              <div className="area-search-meta" aria-live="polite">
                <span>{areaSearchQuery ? `${areaOptions.length} matches` : "Suggested areas"}</span>
                <span>Type to search all barangays</span>
              </div>

              <div id="area-search-results" className="area-search-results" role="listbox" aria-label="Albay areas">
                {areaOptions.length > 0 ? (
                  areaOptions.map((option, index) => (
                    <button
                      key={option.key}
                      id={`area-option-${index}`}
                      type="button"
                      role="option"
                      aria-selected={option.key === selectedAreaKey}
                      className={`${index === activeAreaOptionIndex ? "is-active" : ""}${
                        option.key === selectedAreaKey ? " is-selected" : ""
                      }`}
                      onMouseEnter={() => setActiveAreaOptionIndex(index)}
                      onClick={() => selectAreaOption(option)}
                    >
                      <span className={`area-option-level ${option.level}`}>{option.level}</span>
                      <span className="area-option-copy">
                        <strong>{option.label}</strong>
                        <small>{option.description}</small>
                      </span>
                      <span className="area-option-action" aria-hidden="true">
                        {option.key === selectedAreaKey ? "Selected" : "View"}
                      </span>
                    </button>
                  ))
                ) : (
                  <div className="area-search-empty">
                    <strong>No matching area</strong>
                    <span>Try a municipality name or a shorter barangay search.</span>
                  </div>
                )}
              </div>
            </section>
          </div>
        ) : null}

        <header className="district-forward-header">
          <div className="district-forward-brand-wrap">
            <h1 className="district-forward-brand">
              <Image
                className="district-forward-brand-logo"
                src="/logo.svg"
                alt=""
                aria-hidden="true"
                width={32}
                height={32}
                priority
                unoptimized
              />
              <span>Flood Monitor</span>
            </h1>
            <small>Service Landings • GIS Flood Intelligence</small>
          </div>
          <div className="district-forward-area-picker district-forward-header-area-picker">
            <div className="area-picker-heading">
              <span className="area-picker-heading-label">Area search</span>
              <span>
                {barangayData.features.length > 0
                  ? `${barangayData.features.length} mapped`
                  : barangayError
                    ? "GIS unavailable"
                    : "Loading GIS"}
              </span>
            </div>
            <div className="area-picker-select-wrap">
              <button
                ref={areaPickerTriggerRef}
                id="area-picker-trigger"
                type="button"
                className="area-picker-trigger"
                onClick={openAreaPicker}
                disabled={barangayData.features.length === 0}
                aria-label={`Area search, current selection: ${areaPickerLabel}`}
                aria-haspopup="dialog"
                aria-expanded={isAreaPickerOpen}
                aria-busy={barangayData.features.length === 0 && !barangayError}
              >
                <span>{areaPickerLabel}</span>
                <span className="area-search-icon" aria-hidden="true" />
              </button>
            </div>
          </div>
          <div className="district-forward-header-actions">
            <div
              className={`live-data-status ${liveFeedState}`}
              role="status"
              aria-live="polite"
              aria-label={`${liveFeedLabel}. ${formatRelativeAge(lastWeatherUpdatedAt)}.`}
            >
              <span className="live-data-beacon" aria-hidden="true" />
              <span className="live-data-copy">
                <strong>{liveFeedLabel}</strong>
                <em>{formatRelativeAge(lastWeatherUpdatedAt)}</em>
              </span>
            </div>
            <button
              type="button"
              className="district-forward-refresh"
              onClick={resetFocusView}
              disabled={!mapLoaded}
              aria-label={`Reset map to ${location.label}`}
            >
              <span className="refresh-label-wide">
                {selectedBarangay ? "Reset barangay view" : selectedMunicipality ? "Reset municipality view" : "Reset Albay view"}
              </span>
              <span className="refresh-label-compact">Reset view</span>
            </button>
          </div>
        </header>

        <div className={`district-forward-grid${isReadingsPanelOpen ? "" : " readings-collapsed"}`}>
          <aside className="district-forward-sidebar" aria-label="Controls and snapshot metrics">
            <p className="district-forward-eyebrow">Hydrology workspace</p>
            <h2 className="district-forward-title">Selected-area model snapshot</h2>
            <p className="district-forward-lede">
              Numerical weather-model values for one representative point, not observations for the full selected area or an official flood warning.
            </p>

            <div
              className={`official-rain-observation ${featuredOfficialGaugeState}`}
              aria-label="Latest official PAGASA rain-gauge observation in Albay"
            >
              <span>
                PAGASA measured rain
                {isOfficialRainfallRefreshing ? <em>Syncing</em> : null}
              </span>
              <strong>
                {featuredOfficialGauge?.hourly_rain_mm !== null &&
                featuredOfficialGauge?.hourly_rain_mm !== undefined
                  ? `${formatNumber(featuredOfficialGauge.hourly_rain_mm, 1)} mm`
                  : "Unavailable"}
              </strong>
              <small>
                {featuredOfficialGauge
                  ? `${featuredOfficialGauge.site_name} · ${
                      featuredOfficialGauge.observed_at
                        ? `preceding hour at ${formatTime(featuredOfficialGauge.observed_at)}`
                        : "no observation time"
                    } · ${featuredOfficialGaugeState}`
                  : officialRainfallError || "Loading official Albay station observations…"}
              </small>
              <small>Station-specific measurement; not substituted into the area-wide model calculation.</small>
            </div>

            <div className="district-forward-matrix" aria-label={`Model-point snapshot for ${location.label}`}>
              <div className="district-forward-cell">
                <strong>
                  {weather ? `${formatNumber(weather.current.precipitation)} ${weather.current_units.precipitation}` : "—"}
                </strong>
                <small>Model rain / {currentRainIntervalMinutes} min</small>
              </div>
              <div className="district-forward-cell">
                <strong title={selectedRainRateBasis}>
                  {analysis ? `${formatNumber(analysis.selectedRainRateMmPerHour)} mm/h` : "—"}
                </strong>
                <small>Avg selected rain rate</small>
              </div>
              <div className="district-forward-cell">
                <strong
                  className="metric-value"
                  title={
                    analysis
                      ? `${formatNumber(analysis.estimatedWaterLiters, 0)} liters of gross modeled rainfall, assuming uniform rain across the circular zone`
                      : undefined
                  }
                  aria-label={analysis ? `${formatNumber(analysis.estimatedWaterLiters, 0)} liters` : undefined}
                >
                  {analysis ? `${formatCompactNumber(analysis.estimatedWaterLiters)} L` : "—"}
                </strong>
                <small>Gross rainfall volume</small>
              </div>
              <div className="district-forward-cell">
                <strong>
                  {weather
                    ? `${formatNumber(weather.current.temperature_2m, 1)} ${weather.current_units.temperature_2m}`
                    : "—"}
                </strong>
                <small>Model temperature at 2 m</small>
              </div>
              <div className="district-forward-cell">
                <strong
                  className="metric-value"
                  title={analysis ? `${formatNumber(analysis.radiusAreaKm2)} square kilometers` : undefined}
                  aria-label={analysis ? `${formatNumber(analysis.radiusAreaKm2)} square kilometers` : undefined}
                >
                  {analysis ? `${formatCompactNumber(analysis.radiusAreaKm2)} km²` : "—"}
                </strong>
                <small>Circular analysis area</small>
              </div>
              <div className="district-forward-cell">
                <strong>{weather ? getWeatherLabel(weather.current.weather_code) : "—"}</strong>
                <small>Current model weather</small>
              </div>
            </div>

            <div className="district-forward-controlblock">
              <h2>Analysis controls</h2>

              <div className="control-row">
                <label className="control-label" htmlFor="radius-km">
                  Analysis radius
                  <span className="value">{radiusKm} km</span>
                </label>
                <input
                  id="radius-km"
                  type="range"
                  min={0}
                  max={radiusSliderMaxKm}
                  step={1}
                  value={radiusKm}
                  onChange={(event) => {
                    radiusWasAdjustedRef.current = true;
                    setRadiusKm(Number(event.target.value));
                  }}
                  aria-describedby="radius-description"
                />
                <small id="radius-description" className="control-description">
                  The default {provinceCoverageRadiusKm || "—"} km radius is calculated from the validated Albay boundary
                  and covers the whole province from its focus point. Reduce it to inspect smaller circular areas; this is
                  not a drainage catchment.
                </small>
              </div>

              <div className="control-row">
                <label className="control-label" htmlFor="accumulation-window">
                  Rain accumulation window
                  <span className="value">{safeHours} h</span>
                </label>
                <input
                  id="accumulation-window"
                  type="range"
                  min={1}
                  max={48}
                  value={safeHours}
                  onChange={(event) => setHoursWindow(Number(event.target.value))}
                  disabled={!hasWeather}
                  aria-describedby="accum-window-description"
                />
                <small id="accum-window-description" className="control-description">
                  Uses latest forecast window ending at selected hour.
                </small>
              </div>

              <fieldset className="district-forward-layers">
                <legend>Visible GIS layers</legend>
                <div className="district-forward-layer-content">
                  <div className="layer-options">
                    <label>
                      <input
                        type="checkbox"
                        checked={layerVisibility.barangays}
                        onChange={(event) =>
                          setLayerVisibility((current) => ({ ...current, barangays: event.target.checked }))
                        }
                      />
                      <span>Barangay boundaries</span>
                      <strong>{barangayData.features.length || "—"}</strong>
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={layerVisibility.rainZone}
                        onChange={(event) =>
                          setLayerVisibility((current) => ({ ...current, rainZone: event.target.checked }))
                        }
                      />
                      <span>Rain accumulation zone</span>
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={layerVisibility.rainAnimation}
                        onChange={(event) =>
                          setLayerVisibility((current) => ({ ...current, rainAnimation: event.target.checked }))
                        }
                      />
                      <span>Rain-rate visualization</span>
                      <strong>{analysis ? `${formatNumber(analysis.selectedRainRateMmPerHour)}mm/h` : "—"}</strong>
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={layerVisibility.waterways}
                        onChange={(event) =>
                          setLayerVisibility((current) => ({ ...current, waterways: event.target.checked }))
                        }
                      />
                      <span>Waterways & drainage</span>
                      <strong>{hydrologyStatus === "ready" ? hydroCounts.waterways : "—"}</strong>
                    </label>
                    <label>
                      <input
                        type="checkbox"
                        checked={layerVisibility.waterAreas}
                        onChange={(event) =>
                          setLayerVisibility((current) => ({ ...current, waterAreas: event.target.checked }))
                        }
                      />
                      <span>Waterbody polygons</span>
                      <strong>{hydrologyStatus === "ready" ? hydroCounts.waterAreas : "—"}</strong>
                    </label>
                  </div>
                  <small className="control-description">
                    Rain dots are an illustrative animation driven by the displayed model rate; individual dots are not measurements.
                  </small>
                  <small className="control-description">
                    OpenStreetMap water features are selected by the complete {selectedAreaLevel.toLowerCase()} boundary,
                    independently of the rainfall radius.
                  </small>
                  {hydrologyStatus === "ready" ? (
                    <small className="control-description">
                      {hydroCounts.rivers} river segments • {hydroCounts.streams} streams • {hydroCounts.canals} canals •{" "}
                      {hydroCounts.drains + hydroCounts.ditches} drains/ditches
                    </small>
                  ) : null}
                </div>
              </fieldset>

              <p className="control-description data-source-note">
                Sources:{" "}
                <a href={DATA_SOURCES.weather.documentationUrl} target="_blank" rel="noreferrer">
                  Open-Meteo model
                </a>{" "}
                •{" "}
                <a href={DATA_SOURCES.officialRainfall.endpoint} target="_blank" rel="noreferrer">
                  PAGASA gauges
                </a>{" "}
                •{" "}
                <a href={DATA_SOURCES.administrativeNames.url} target="_blank" rel="noreferrer">
                  PSA/NAMRIA boundaries
                </a>{" "}
                •{" "}
                <a href={DATA_SOURCES.hydrology.copyrightUrl} target="_blank" rel="noreferrer">
                  © OpenStreetMap contributors
                </a>
                . No official warning data.
              </p>

            </div>
          </aside>

          <section className="district-forward-map" aria-label="Albay Province map view">
            <div
              ref={mapContainerRef}
              id="map"
              role="application"
              aria-label="Interactive 3D satellite map showing modeled rainfall and contextual water networks across Albay Province"
            />
            <canvas ref={rainCanvasRef} className="rain-particle-layer" aria-hidden="true" />

            <div
              className={`district-forward-legend${isMobileLegendOpen ? " is-open" : ""}`}
              aria-label="Map legend"
            >
              <button
                type="button"
                className="mobile-legend-toggle"
                aria-expanded={isMobileLegendOpen}
                aria-controls="map-legend-items"
                onClick={() => setIsMobileLegendOpen((isOpen) => !isOpen)}
              >
                <span className="district-forward-dot terrain" aria-hidden="true" />
                Map key
                <span className="mobile-legend-chevron" aria-hidden="true" />
              </button>
              <div id="map-legend-items" className="legend-items">
                <span title="3D satellite terrain">
                  <span className="district-forward-dot terrain" aria-hidden="true" />
                  3D terrain
                </span>
                <span className={layerVisibility.rainZone ? "" : "is-hidden"} title="Circular rain analysis zone">
                  <span
                    className="district-forward-dot"
                    style={{ backgroundColor: RAIN_ANALYSIS_ZONE_COLOR }}
                    aria-hidden="true"
                  />
                  Rain zone
                </span>
                <span className={layerVisibility.barangays ? "" : "is-hidden"} title="Barangay boundaries">
                  <span className="district-forward-dot barangay" aria-hidden="true" />
                  Barangays
                </span>
                <span className={layerVisibility.rainAnimation ? "" : "is-hidden"} title="Illustrative animation driven by the modeled rain rate">
                  <span className="district-forward-dot rain" aria-hidden="true" />
                  Rain animation
                </span>
                <span className={layerVisibility.waterways ? "" : "is-hidden"} title="Rivers and streams">
                  <span
                    className="district-forward-dot"
                    style={{ backgroundColor: "#3a5c84" }}
                    aria-hidden="true"
                  />
                  Rivers
                </span>
                <span className={layerVisibility.waterAreas ? "" : "is-hidden"} title="Waterbody polygons">
                  <span
                    className="district-forward-dot water-area"
                    aria-hidden="true"
                  />
                  Waterbodies
                </span>
                <span title="Model focus">
                  <span
                    className="district-forward-dot round"
                    style={{ backgroundColor: "#0d1112" }}
                    aria-hidden="true"
                  />
                  Focus
                </span>
              </div>
            </div>

            <div className="district-forward-timeline" aria-label="Rain accumulation timeline">
              <div className="timeline-heading">
                <div>
                  <span>Open-Meteo rain timeline</span>
                  <strong>{selectedForecastTime ? formatTime(selectedForecastTime) : "Waiting for weather data"}</strong>
                </div>
                <div className="timeline-reading" aria-live="polite">
                  <span>{selectedHourPhase}</span>
                  <strong>{analysis ? `${formatNumber(analysis.precipWindowMm, 1)} mm / ${safeHours}h` : "—"}</strong>
                </div>
                <div className="timeline-actions">
                  <select
                    className="timeline-speed-select"
                    value={timelinePlaybackSpeed}
                    onChange={(event) =>
                      setTimelinePlaybackSpeed(Number(event.target.value) as TimelinePlaybackSpeed)
                    }
                    disabled={!hasWeather}
                    aria-label="Timeline playback speed"
                    title="Timeline playback speed"
                  >
                    <option value={1}>1× speed</option>
                    <option value={2}>2× speed</option>
                    <option value={3}>3× speed</option>
                    <option value={4}>4× speed</option>
                  </select>
                  <button
                    type="button"
                    onClick={() => {
                      if (!isTimelinePlaying && safeForecastHour >= maxForecastHour) {
                        setForecastHour(0);
                      }
                      setIsTimelinePlaying((playing) => !playing);
                    }}
                    disabled={!hasWeather}
                    aria-pressed={isTimelinePlaying}
                  >
                    {isTimelinePlaying ? "Pause" : "Play"}
                  </button>
                </div>
              </div>
              <input
                id="rain-timeline"
                type="range"
                min={0}
                max={maxForecastHour}
                value={safeForecastHour}
                onChange={(event) => {
                  setIsTimelinePlaying(false);
                  setForecastHour(Number(event.target.value));
                }}
                disabled={!hasWeather}
                aria-label="Select rain accumulation hour"
              />
              <div className="timeline-scale" aria-hidden="true">
                <span>{firstTimelineTime ? formatTime(firstTimelineTime) : "Past"}</span>
                <span>Now</span>
                <span>{maxForecastLabel !== "N/A" ? formatTime(maxForecastLabel) : "Forecast"}</span>
              </div>
            </div>
          </section>

          <aside
            className={`district-forward-right${isReadingsPanelOpen ? " is-open" : " is-collapsed"}`}
            aria-label="Model readings"
          >
            <button
              type="button"
              className="readings-rail-toggle"
              aria-expanded={isReadingsPanelOpen}
              aria-controls="readings-panel-content"
              aria-label={isReadingsPanelOpen ? "Collapse readings panel" : "Expand readings panel"}
              onClick={() => setIsReadingsPanelOpen((isOpen) => !isOpen)}
            >
              <span className="readings-toggle-arrow" aria-hidden="true">
                {isReadingsPanelOpen ? "→" : "←"}
              </span>
              <span>{isReadingsPanelOpen ? "Hide" : "Readings"}</span>
            </button>

            <div
              id="readings-panel-content"
              className="readings-panel-content"
              aria-hidden={!isReadingsPanelOpen}
            >
              <h2>Readings</h2>

            <div className="district-forward-meta">
              <div className="district-forward-meta-row">
                <span>Modeled accumulation window</span>
                <span>
                  {analysis && weather
                    ? `${formatTime(analysis.windowStartTime)} → ${formatTime(analysis.windowEndTime)}`
                    : "—"}
                </span>
              </div>
              <div className="district-forward-meta-row">
                <span>Avg selected rain rate</span>
                <span>
                  {analysis ? `${formatNumber(analysis.selectedRainRateMmPerHour)} mm/h` : "—"}
                </span>
              </div>
              <div className="district-forward-meta-row">
                <span>Modeled window total</span>
                <span>{analysis ? `${formatNumber(analysis.precipWindowMm, 1)} mm` : "—"}</span>
              </div>
              <div className="district-forward-meta-row">
                <span>Measured rainfall source</span>
                <span>
                  <a href={DATA_SOURCES.officialRainfall.endpoint} target="_blank" rel="noreferrer">
                    DOST-PAGASA gauges
                  </a>{" "}
                  • preceding-hour station values
                </span>
              </div>
              {officialRainfall?.stations.map((station) => {
                const stationState = getOfficialGaugeState(station);
                return (
                  <div className="district-forward-meta-row" key={station.site_id}>
                    <span>{station.site_name}</span>
                    <span>
                      {station.hourly_rain_mm === null
                        ? "No reported rain value"
                        : `${formatNumber(station.hourly_rain_mm, 1)} mm`}
                      {station.observed_at ? ` • ${formatTime(station.observed_at)}` : ""}
                      {` • ${stationState}`}
                    </span>
                  </div>
                );
              })}
              {!officialRainfall ? (
                <div className="district-forward-meta-row">
                  <span>Albay gauge status</span>
                  <span>
                    {isOfficialRainfallRefreshing
                      ? "Loading from PAGASA"
                      : officialRainfallError || "Waiting"}
                  </span>
                </div>
              ) : null}
              <div className="district-forward-meta-row">
                <span>Selected 10 m wind</span>
                <span>
                  {analysis
                    ? `${formatNumber(analysis.selectedWindSpeedKph, 1)} km/h from ${formatWindDirection(
                        analysis.selectedWindDirectionDegrees
                      )}`
                    : "—"}
                </span>
              </div>
              <div className="district-forward-meta-row">
                <span>Weather source</span>
                <span>
                  <a href={DATA_SOURCES.weather.documentationUrl} target="_blank" rel="noreferrer">
                    Open-Meteo Forecast API
                  </a>{" "}
                  • best-match model
                </span>
              </div>
              <div className="district-forward-meta-row">
                <span>Model data time</span>
                <span>{weather ? formatTime(weather.current.time) : "—"}</span>
              </div>
              <div className="district-forward-meta-row">
                <span>Model grid point</span>
                <span>{weather ? `${weather.latitude.toFixed(5)}, ${weather.longitude.toFixed(5)}` : "—"}</span>
              </div>
              <div className="district-forward-meta-row">
                <span>Boundary names / codes</span>
                <span>
                  <a href={DATA_SOURCES.administrativeNames.url} target="_blank" rel="noreferrer">
                    PSA PSGC
                  </a>{" "}
                  • {DATA_SOURCES.administrativeNames.snapshot}
                </span>
              </div>
              <div className="district-forward-meta-row">
                <span>Boundary geometry</span>
                <span>
                  <a href={DATA_SOURCES.administrativeGeometry.url} target="_blank" rel="noreferrer">
                    NAMRIA-derived release
                  </a>{" "}
                  • {DATA_SOURCES.administrativeGeometry.snapshot}
                </span>
              </div>
              <div className="district-forward-meta-row">
                <span>Verified Albay coverage</span>
                <span>
                  {barangayData.features.length > 0
                    ? `${municipalityOptions.length} LGUs • ${barangayData.features.length} barangays`
                    : "—"}{" "}
                  • PSA {VERIFIED_ALBAY_COVERAGE.verifiedAsOf}
                </span>
              </div>
              <div className="district-forward-meta-row">
                <span>Water-feature source</span>
                <span>
                  <a href={DATA_SOURCES.hydrology.copyrightUrl} target="_blank" rel="noreferrer">
                    © OpenStreetMap contributors
                  </a>{" "}
                  • volunteered context
                </span>
              </div>
              <div className="district-forward-meta-row">
                <span>Water-feature coverage</span>
                <span>
                  {hydrologyStatus === "ready"
                    ? `${hydroCounts.rivers} rivers • ${hydroCounts.streams} streams • ${hydroCounts.canals} canals • ${hydroCounts.drains + hydroCounts.ditches} drains/ditches • ${hydroCounts.waterAreas} waterbodies`
                    : "—"}
                </span>
              </div>
              <div className="district-forward-meta-row">
                <span>OSM dataset timestamp</span>
                <span>{hydrologyDatasetUpdatedAt ? formatRelativeAge(hydrologyDatasetUpdatedAt) : "—"}</span>
              </div>
              <div className="district-forward-meta-row">
                <span>Water-feature retrieval</span>
                <span>
                  {hydrologyStatus === "ready"
                    ? formatRelativeAge(hydrologyRetrievedAt)
                    : hydrologyStatus === "loading"
                      ? "Loading from OpenStreetMap"
                      : hydrologyStatus === "error"
                        ? "Unavailable"
                        : "Waiting"}
                </span>
              </div>
              <div className="district-forward-meta-row">
                <span>Last synchronized</span>
                <span>{formatRelativeAge(lastWeatherUpdatedAt)}</span>
              </div>
              <div className="district-forward-meta-row">
                <span>Next automatic sync</span>
                <span>{nextSyncMinutes === null ? "—" : nextSyncMinutes === 0 ? "Due now" : `In ${nextSyncMinutes} min`}</span>
              </div>
              <div className="district-forward-meta-row">
                <span>Focus area</span>
                <span>{location.label}</span>
              </div>
              <div className="district-forward-meta-row">
                <span>Area mode</span>
                <span>{selectedAreaLevel}</span>
              </div>
              <div className="district-forward-meta-row">
                <span>Selected boundary area</span>
                <span>{selectedAreaSqKm > 0 ? `${formatNumber(selectedAreaSqKm, 2)} km²` : "—"}</span>
              </div>
              <div className="district-forward-meta-row">
                <span>Status message</span>
                <span>{status}</span>
              </div>
              <div className="district-forward-meta-row">
                <span>Derived focus point</span>
                <span>{`${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`}</span>
              </div>
              <div className="district-forward-meta-row">
                <span>Model-point elevation</span>
                <span>{weather ? `${formatNumber(weather.elevation, 0)} m` : "—"}</span>
              </div>
              <div className="district-forward-meta-row">
                <span>Latest error</span>
                <span>{latestError || "None"}</span>
              </div>
              <div className="district-forward-meta-row">
                <span>Official warnings</span>
                <span>
                  Not provided here •{" "}
                  <a href={DATA_SOURCES.officialGuidance.url} target="_blank" rel="noreferrer">
                    check PAGASA
                  </a>
                </span>
              </div>
              </div>
            </div>
          </aside>
        </div>
      </section>
    </main>
  );
}
