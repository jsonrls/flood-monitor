"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import Link from "next/link";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Polygon, Point, MultiPolygon } from "geojson";
import FloodLoadingIcon from "./FloodLoadingIcon";
import FloodReportDialog from "./FloodReportDialog";
import { DATA_SOURCES, VERIFIED_ALBAY_COVERAGE } from "@/lib/dataSources";
import {
  type FloodDepth,
  type FloodReport,
  type FloodReportLocation,
  type VehicleAccess,
  confirmFloodReport,
  getFloodReportSubmissionErrorMessage,
  isFirebaseConfigured,
  submitFloodReport,
  subscribeToFloodReports
} from "@/lib/floodReports";

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

type WeatherSyncReason = "initial" | "automatic" | "focus" | "reconnect" | "area";
type FloodReportMode = "closed" | "locating" | "placing" | "details";

type Analysis = {
  boundary: Feature<Polygon | MultiPolygon>;
  landAreaKm2: number;
  precipWindowMm: number;
  estimatedWaterLiters: number;
  selectedRainRateMmPerHour: number;
  selectedWindSpeedKph: number;
  selectedWindDirectionDegrees: number;
  windowStartTime: string;
  windowEndTime: string;
};

type LayerVisibility = {
  rainAnimation: boolean;
  traffic: boolean;
};

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
const LAYER_VISIBILITY_STORAGE_KEY = "albay-flood-monitor:gis-layers:v1";
const DEFAULT_LAYER_VISIBILITY: LayerVisibility = {
  rainAnimation: true,
  traffic: true
};

// Published by the Office of the Governor of Albay (official hotline advisory).
const ALBAY_EMERGENCY_HOTLINES = [
  { label: "National emergency", display: "911", tel: "911", primary: true },
  { label: "Albay PDRRMO disaster ops", display: "(052) 480-5222", tel: "+63524805222" },
  { label: "EMS Albay medical", display: "0918-911-9911", tel: "+639189119911" },
  { label: "Fire (BFP Albay)", display: "(052) 481-5013", tel: "+63524815013" },
  { label: "Police (PNP Albay)", display: "0909-441-0630", tel: "+639094410630" },
  { label: "Red Cross Albay", display: "0907-933-8303", tel: "+639079338303" },
  { label: "Coast Guard", display: "0921-524-6355", tel: "+639215246355" }
] as const;

const TRAFFIC_CONGESTION_COLORS: mapboxgl.ExpressionSpecification = [
  "match",
  ["get", "congestion"],
  "low", "#48b77b",
  "moderate", "#f1b934",
  "heavy", "#ed8b3c",
  "severe", "#d94640",
  "rgba(0, 0, 0, 0)"
];
// Downtown Legazpi barangays are single city blocks, so the first Wi-Fi/cell
// estimate (±30–150 m) routinely lands in the wrong barangay. A fix at or under
// the target accuracy finishes immediately; anything rougher keeps the GPS watch
// running so a later, tighter fix can replace it before the window closes.
const DEVICE_LOCATION_TARGET_ACCURACY_M = 20;
const DEVICE_LOCATION_GOOD_ACCURACY_M = 40;
const DEVICE_LOCATION_MAX_USABLE_ACCURACY_M = 120;
const DEVICE_LOCATION_REFINEMENT_GRACE_MS = 5_000;
const DEVICE_LOCATION_REQUEST_TIMEOUT_MS = 20_000;
const DEVICE_LOCATION_MAX_AGE_MS = 10_000;

type DeviceLocationFailureReason = "unsupported" | "denied" | "unavailable" | "timeout" | "invalid";

const DEVICE_LOCATION_FAILURE_MESSAGES: Record<DeviceLocationFailureReason, string> = {
  unsupported: "Device location needs HTTPS (or localhost) and a browser that supports geolocation.",
  denied: "Location access is blocked for this site. Allow it in your browser's site settings.",
  unavailable: "GPS signal is unavailable right now — try again near a window or outdoors.",
  timeout: "Locating took too long.",
  invalid: "Your device returned an invalid location reading."
};

const formatAccuracy = (accuracyM: number) =>
  accuracyM >= 1000 ? `${(accuracyM / 1000).toFixed(1)} km` : `${Math.max(1, Math.round(accuracyM))} m`;
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

const ALBAY_PROVINCE_CODE = "05005";
// Default camera: 3D view over Legazpi City's Old Albay district with
// Peñaranda Park in the near foreground and the airport/Bicol University
// corridor in view. The recenter control still fits the full province.
const DEFAULT_MAP_CENTER: [number, number] = [123.7376529, 13.1403011];
const DEFAULT_MAP_ZOOM = 16;
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

const FLOOD_DEPTH_LABELS: Record<FloodDepth, string> = {
  none: "No flooding",
  ankle: "Ankle deep",
  knee: "Knee deep",
  waist: "Waist deep",
  chest: "Chest deep or higher"
};

const VEHICLE_ACCESS_LABELS: Record<VehicleAccess, string> = {
  passable: "Passable",
  difficult: "Difficult",
  impassable: "Impassable"
};

const FLOOD_REPORT_HEAT_COLORS: Record<FloodDepth, { glow: string; core: string }> = {
  none: { glow: "72, 183, 123", core: "43, 141, 92" },
  ankle: { glow: "80, 200, 187", core: "38, 152, 141" },
  knee: { glow: "241, 185, 52", core: "203, 146, 18" },
  waist: { glow: "237, 139, 60", core: "198, 100, 25" },
  chest: { glow: "217, 70, 64", core: "173, 40, 36" }
};

const FLOOD_REPORT_HEAT_LAYER_IDS = (Object.keys(FLOOD_REPORT_HEAT_COLORS) as FloodDepth[]).map(
  (depth) => `community-flood-report-heat-${depth}`
);

const floodReportHeatRadius = (scale: number): mapboxgl.ExpressionSpecification => [
  "interpolate",
  ["linear"],
  ["zoom"],
  8,
  24 * scale,
  12,
  40 * scale,
  16,
  62 * scale
];

const floodReportCoreRadius = (scale: number): mapboxgl.ExpressionSpecification => [
  "interpolate",
  ["linear"],
  ["zoom"],
  8,
  6 * scale,
  16,
  9 * scale
];

const floodReportCoreStrokeWidth = (scale: number): mapboxgl.ExpressionSpecification => [
  "interpolate",
  ["linear"],
  ["zoom"],
  8,
  2.2 * scale,
  16,
  3 * scale
];

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
    detail: "Loading the Mapbox basemap, elevation terrain, and map controls."
  }
];

const READY_LOADING_STAGE = {
  title: "Source data ready",
  detail: "Weather-model, boundary, and terrain sources are loaded."
};

const toFeatureCollection = (): FeatureCollection => ({
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

const formatMunicipalityName = (name: string) => {
  if (name === "City of Ligao") return "Ligao City";
  if (name === "City of Tabaco") return "Tabaco City";
  if (name === "Legazpi City (Capital)") return "Legazpi City";
  return name;
};

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
  const reportMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const deviceLocationMarkerRef = useRef<mapboxgl.Marker | null>(null);
  const lastDeviceLocationRef = useRef<{ position: GeolocationPosition; receivedAt: number } | null>(null);
  const locateDeviceCancelRef = useRef<(() => void) | null>(null);
  const hasAutoCenteredOnDeviceRef = useRef(false);
  const reportLocationCancelRef = useRef<(() => void) | null>(null);
  const reportLocationRequestIdRef = useRef(0);
  const reportLocationElapsedIntervalRef = useRef<number | null>(null);
  const reportTriggerRef = useRef<HTMLButtonElement | null>(null);
  const weatherFocusKeyRef = useRef<string | null>(null);
  const weatherRef = useRef<WeatherResponse | null>(null);
  const weatherRequestIdRef = useRef(0);
  const weatherLastRequestAtRef = useRef(0);
  const lastWeatherUpdatedAtRef = useRef<number | null>(null);
  const officialRainfallRequestIdRef = useRef(0);
  const officialRainDialogTriggerRef = useRef<HTMLButtonElement | null>(null);
  const officialRainDialogCloseRef = useRef<HTMLButtonElement | null>(null);
  const [, setStatus] = useState("Preparing Albay Province data...");
  const [isLocatingDevice, setIsLocatingDevice] = useState(false);
  const [weather, setWeather] = useState<WeatherResponse | null>(null);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [isWeatherRefreshing, setIsWeatherRefreshing] = useState(false);
  const [lastWeatherUpdatedAt, setLastWeatherUpdatedAt] = useState<number | null>(null);
  const [officialRainfall, setOfficialRainfall] = useState<OfficialRainfallResponse | null>(null);
  const [officialRainfallError, setOfficialRainfallError] = useState<string | null>(null);
  const [isOfficialRainfallRefreshing, setIsOfficialRainfallRefreshing] = useState(false);
  const [isOnline, setIsOnline] = useState(true);
  const [clockNow, setClockNow] = useState<number | null>(null);
  const [barangayData, setBarangayData] = useState<BarangayFeatureCollection>(toBarangayFeatureCollection());
  const [barangayError, setBarangayError] = useState<string | null>(null);
  const [layerVisibility, setLayerVisibility] = useState<LayerVisibility>(DEFAULT_LAYER_VISIBILITY);
  const [hasLoadedLayerPreferences, setHasLoadedLayerPreferences] = useState(false);
  const [mapLoaded, setMapLoaded] = useState(false);
  const [trafficProvider, setTrafficProvider] = useState<"tomtom" | "mapbox">("mapbox");
  const [mapViewMode, setMapViewMode] = useState<"2d" | "3d">("3d");
  const [error, setError] = useState<string | null>(null);
  const [hasFinishedInitialLoad, setHasFinishedInitialLoad] = useState(false);
  const [isMobileLegendOpen, setIsMobileLegendOpen] = useState(false);
  const [isOfficialRainDialogOpen, setIsOfficialRainDialogOpen] = useState(false);
  const [communityFloodReports, setCommunityFloodReports] = useState<FloodReport[]>([]);
  const [communityFloodReportError, setCommunityFloodReportError] = useState<string | null>(null);
  const [floodReportMode, setFloodReportMode] = useState<FloodReportMode>("closed");
  const [floodReportLocationStatus, setFloodReportLocationStatus] = useState("Requesting precise device location…");
  const [floodReportLocationElapsedMs, setFloodReportLocationElapsedMs] = useState(0);
  const [floodReportLocationDenied, setFloodReportLocationDenied] = useState(false);
  const [floodReportLocation, setFloodReportLocation] = useState<FloodReportLocation | null>(null);
  const [floodReportDepth, setFloodReportDepth] = useState<FloodDepth | null>(null);
  const [floodReportVehicleAccess, setFloodReportVehicleAccess] = useState<VehicleAccess | null>(null);
  const [floodReportError, setFloodReportError] = useState<string | null>(null);
  const [isSubmittingFloodReport, setIsSubmittingFloodReport] = useState(false);
  const [isFloodReportSubmitted, setIsFloodReportSubmitted] = useState(false);
  const [userReportVotes, setUserReportVotes] = useState<Record<string, "still-flooded" | "cleared">>({});
  const userVotesRef = useRef<Record<string, "still-flooded" | "cleared">>({});
  userVotesRef.current = userReportVotes;

  const handleVoteReportRef = useRef<(reportId: string, vote: "still-flooded" | "cleared") => void>(() => { });

  useEffect(() => {
    try {
      const stored = window.localStorage.getItem("flood_report_votes");
      if (stored) {
        setUserReportVotes(JSON.parse(stored) as Record<string, "still-flooded" | "cleared">);
      }
    } catch {
      // Ignore storage errors
    }
  }, []);

  const handleVoteReport = useCallback(async (reportId: string, vote: "still-flooded" | "cleared") => {
    const prevVote = userVotesRef.current[reportId];
    if (prevVote === vote) return;

    setUserReportVotes((prev) => {
      const updated = { ...prev, [reportId]: vote };
      try {
        window.localStorage.setItem("flood_report_votes", JSON.stringify(updated));
      } catch {
        // Ignore storage errors
      }
      return updated;
    });

    setCommunityFloodReports((prev) =>
      prev.map((rep) => {
        if (rep.id !== reportId) return rep;
        let stillCount = rep.stillFloodedCount ?? 1;
        let clearCount = rep.clearedCount ?? 0;

        if (vote === "still-flooded") {
          stillCount += 1;
          if (prevVote === "cleared") clearCount = Math.max(0, clearCount - 1);
        } else if (vote === "cleared") {
          clearCount += 1;
          if (prevVote === "still-flooded") stillCount = Math.max(0, stillCount - 1);
        }

        return {
          ...rep,
          stillFloodedCount: stillCount,
          clearedCount: clearCount
        };
      })
    );

    await confirmFloodReport(reportId, vote);
  }, []);

  handleVoteReportRef.current = handleVoteReport;

  useEffect(() => {
    try {
      const storedPreferences = window.localStorage.getItem(LAYER_VISIBILITY_STORAGE_KEY);
      if (storedPreferences) {
        const parsedPreferences = JSON.parse(storedPreferences) as Partial<LayerVisibility>;
        const restoredPreferences = Object.fromEntries(
          Object.entries(DEFAULT_LAYER_VISIBILITY).map(([layer, defaultValue]) => [
            layer,
            typeof parsedPreferences[layer as keyof LayerVisibility] === "boolean"
              ? parsedPreferences[layer as keyof LayerVisibility]
              : defaultValue
          ])
        ) as LayerVisibility;

        setLayerVisibility(restoredPreferences);
      }
    } catch {
      // Restricted or malformed browser storage should not prevent the map from loading.
    } finally {
      setHasLoadedLayerPreferences(true);
    }
  }, []);

  useEffect(() => {
    if (!hasLoadedLayerPreferences) return;

    try {
      window.localStorage.setItem(LAYER_VISIBILITY_STORAGE_KEY, JSON.stringify(layerVisibility));
    } catch {
      // Layer controls remain usable for the current session when storage is unavailable.
    }
  }, [hasLoadedLayerPreferences, layerVisibility]);

  const mapToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const albayProvinceBounds = useMemo<[number, number, number, number] | null>(() => {
    if (barangayData.features.length === 0) return null;
    return turf.bbox(barangayData) as [number, number, number, number];
  }, [barangayData]);
  const location = useMemo<FocusLocation>(() => {
    if (barangayData.features.length === 0) {
      return ALBAY_PROVINCE_FOCUS;
    }

    const [lng, lat] = turf.pointOnFeature(barangayData).geometry.coordinates;
    return { lat, lng, label: ALBAY_PROVINCE_FOCUS.label };
  }, [barangayData]);
  const selectedAreaKey = `province:${ALBAY_PROVINCE_CODE}`;
  const selectedAreaBoundary = useMemo(
    () => combineAreaBoundaries(barangayData.features.length > 0 ? barangayData : null),
    [barangayData]
  );
  const selectedAreaLevel = "Province";

  const communityFloodReportGeoJson = useMemo<FeatureCollection<Point>>(
    () => ({
      type: "FeatureCollection",
      features: communityFloodReports.map((report) => ({
        type: "Feature",
        id: report.id,
        geometry: {
          type: "Point",
          coordinates: [report.longitude, report.latitude]
        },
        properties: {
          id: report.id,
          areaLabel: report.areaLabel,
          depth: report.depth,
          depthLabel: FLOOD_DEPTH_LABELS[report.depth],
          vehicleAccess: report.vehicleAccess,
          vehicleAccessLabel: VEHICLE_ACCESS_LABELS[report.vehicleAccess],
          stillFloodedCount: report.stillFloodedCount ?? 1,
          clearedCount: report.clearedCount ?? 0,
          createdAt: report.createdAt.toISOString()
        }
      }))
    }),
    [communityFloodReports]
  );

  const closeOfficialRainDialog = useCallback((restoreFocus = true) => {
    setIsOfficialRainDialogOpen(false);

    if (restoreFocus) {
      window.requestAnimationFrame(() => officialRainDialogTriggerRef.current?.focus());
    }
  }, []);

  useEffect(() => {
    if (!isOfficialRainDialogOpen) return;

    const focusFrame = window.requestAnimationFrame(() => officialRainDialogCloseRef.current?.focus());
    const handleEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        closeOfficialRainDialog();
      }
    };

    document.addEventListener("keydown", handleEscape);
    return () => {
      window.cancelAnimationFrame(focusFrame);
      document.removeEventListener("keydown", handleEscape);
    };
  }, [closeOfficialRainDialog, isOfficialRainDialogOpen]);

  const weatherHourCount = weather?.hourly.time.length ?? 0;
  // Fixed accumulation window: the latest 24 hours ending at the current hour.
  const safeHours = Math.max(1, Math.min(24, weatherHourCount || 24));
  // Without the timeline scrubber the analysis always reflects the hour
  // closest to the provider's current observation.
  const currentWeatherHour = weather ? findClosestTimeIndex(weather.hourly.time, weather.current.time) : 0;

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
    if (!weather || !selectedAreaBoundary) return null;

    const areaSqM = turf.area(selectedAreaBoundary);
    const safeAreaSqM = Number.isFinite(areaSqM) ? areaSqM : 0;

    const start = Math.max(0, currentWeatherHour - safeHours + 1);
    const availableHours = weather.hourly.precipitation.slice(start, currentWeatherHour + 1);
    const precipWindowMm = availableHours.reduce((acc, value) => acc + value, 0);
    const currentIntervalSeconds = Math.max(1, weather.current.interval ?? 3600);
    const selectedRainRateMmPerHour = weather.current.precipitation * (3600 / currentIntervalSeconds);
    const estimatedWaterLiters = safeAreaSqM * precipWindowMm;

    return {
      boundary: selectedAreaBoundary,
      landAreaKm2: safeAreaSqM / 1_000_000,
      precipWindowMm,
      estimatedWaterLiters,
      selectedRainRateMmPerHour,
      selectedWindSpeedKph: weather.current.wind_speed_10m,
      selectedWindDirectionDegrees: weather.current.wind_direction_10m,
      windowStartTime: shiftLocalIsoTime(weather.hourly.time[start], -60),
      windowEndTime: weather.hourly.time[currentWeatherHour]
    };
  }, [weather, selectedAreaBoundary, safeHours, currentWeatherHour]);

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

        const updatedAt = new Date(payload._provenance.served_at).valueOf();

        weatherRef.current = payload;
        lastWeatherUpdatedAtRef.current = updatedAt;
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

  const initializeMap = useCallback(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    if (!mapToken) {
      setError("Missing NEXT_PUBLIC_MAPBOX_TOKEN in your environment.");
      return;
    }

    mapboxgl.accessToken = mapToken;
    const map = new mapboxgl.Map({
      container: mapContainerRef.current,
      style: "mapbox://styles/mapbox/standard",
      config: {
        basemap: {
          lightPreset: "day",
          showPointOfInterestLabels: true,
          showPlaceLabels: true,
          showRoadLabels: true,
          showRoadsAndTransit: true,
          show3dObjects: true
        }
      },
      center: DEFAULT_MAP_CENTER,
      zoom: DEFAULT_MAP_ZOOM,
      pitch: 58,
      bearing: -18,
      projection: "mercator",
      maxPitch: 80,
      antialias: true
    });

    mapRef.current = map;
    map.on("load", () => {
      map.setCenter(DEFAULT_MAP_CENTER);

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

      map.addSource("mapbox-traffic", {
        type: "vector",
        url: "mapbox://mapbox.mapbox-traffic-v1"
      });

      map.addLayer({
        id: "traffic-flow-casing",
        type: "line",
        source: "mapbox-traffic",
        "source-layer": "traffic",
        slot: "middle",
        layout: {
          "line-cap": "round",
          "line-join": "round"
        },
        paint: {
          "line-color": "#ffffff",
          "line-opacity": 0.65,
          "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 8, 2, 12, 4.4, 16, 9]
        }
      });

      map.addLayer({
        id: "traffic-flow-line",
        type: "line",
        source: "mapbox-traffic",
        "source-layer": "traffic",
        slot: "middle",
        layout: {
          "line-cap": "round",
          "line-join": "round"
        },
        paint: {
          "line-color": TRAFFIC_CONGESTION_COLORS,
          "line-opacity": 0.9,
          "line-width": ["interpolate", ["exponential", 1.5], ["zoom"], 8, 1, 12, 2.6, 16, 6]
        }
      });

      map.addSource("tomtom-traffic", {
        type: "raster",
        tiles: [`${window.location.origin}/api/traffic?z={z}&x={x}&y={y}`],
        tileSize: 256,
        minzoom: 5,
        maxzoom: 18,
        attribution: "© TomTom"
      });

      map.addLayer({
        id: "tomtom-traffic-tiles",
        type: "raster",
        source: "tomtom-traffic",
        slot: "middle",
        layout: {
          visibility: "none"
        },
        paint: {
          "raster-opacity": 0.85
        }
      });

      map.addSource("flood-report-location-accuracy", {
        type: "geojson",
        data: toFeatureCollection() as FeatureCollection
      });

      map.addLayer({
        id: "flood-report-location-accuracy-fill",
        type: "fill",
        source: "flood-report-location-accuracy",
        paint: {
          "fill-color": "#2f5fe3",
          "fill-opacity": 0.12
        }
      });

      map.addLayer({
        id: "flood-report-location-accuracy-outline",
        type: "line",
        source: "flood-report-location-accuracy",
        paint: {
          "line-color": "#2f5fe3",
          "line-opacity": 0.72,
          "line-width": 1.5
        }
      });

      map.addSource("community-flood-reports", {
        type: "geojson",
        data: {
          type: "FeatureCollection",
          features: []
        }
      });

      (Object.keys(FLOOD_REPORT_HEAT_COLORS) as FloodDepth[]).forEach((depth) => {
        const { glow, core } = FLOOD_REPORT_HEAT_COLORS[depth];
        map.addLayer({
          id: `community-flood-report-heat-${depth}`,
          type: "heatmap",
          source: "community-flood-reports",
          filter: ["==", ["get", "depth"], depth],
          paint: {
            "heatmap-weight": 1,
            "heatmap-intensity": 1,
            "heatmap-radius": floodReportHeatRadius(1),
            "heatmap-opacity": 0.75,
            "heatmap-color": [
              "interpolate",
              ["linear"],
              ["heatmap-density"],
              0, `rgba(${glow}, 0)`,
              0.2, `rgba(${glow}, 0.08)`,
              0.45, `rgba(${glow}, 0.24)`,
              0.7, `rgba(${glow}, 0.48)`,
              0.9, `rgba(${glow}, 0.7)`,
              1, `rgba(${core}, 0.82)`
            ]
          }
        });
      });

      map.addLayer({
        id: "community-flood-report-points",
        type: "circle",
        source: "community-flood-reports",
        paint: {
          "circle-color": [
            "match",
            ["get", "depth"],
            "none", "#48b77b",
            "ankle", "#50c8bb",
            "knee", "#f1b934",
            "waist", "#ed8b3c",
            "chest", "#d94640",
            "#ffffff"
          ],
          "circle-radius": ["interpolate", ["linear"], ["zoom"], 8, 6, 16, 9],
          "circle-stroke-color": "#ffffff",
          "circle-stroke-opacity": 0.96,
          "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 8, 2.2, 16, 3]
        }
      });

      map.on("mouseenter", "community-flood-report-points", () => {
        map.getCanvas().style.cursor = "pointer";
      });
      map.on("mouseleave", "community-flood-report-points", () => {
        map.getCanvas().style.cursor = "";
      });
      map.on("click", "community-flood-report-points", (event) => {
        const feature = event.features?.[0];
        if (!feature || feature.geometry.type !== "Point") return;

        const properties = feature.properties ?? {};
        const reportId = String(properties.id ?? "");
        const depth = String(properties.depth ?? "none");
        const popupContent = document.createElement("div");
        popupContent.className = `community-report-popup is-${depth}`;

        const reportKicker = document.createElement("div");
        reportKicker.className = "community-report-popup-kicker";
        const reportStatusMark = document.createElement("span");
        reportStatusMark.className = "community-report-status-mark";
        reportStatusMark.setAttribute("aria-hidden", "true");
        const reportEyebrow = document.createElement("span");
        reportEyebrow.textContent = "Community field report";
        reportKicker.append(reportStatusMark, reportEyebrow);

        const locationHeading = document.createElement("strong");
        locationHeading.className = "community-report-location";
        locationHeading.textContent = String(properties.areaLabel ?? "Community flood report");

        const reportReadings = document.createElement("dl");
        reportReadings.className = "community-report-readings";
        const addReading = (label: string, value: string, modifier: string) => {
          const reading = document.createElement("div");
          reading.className = `community-report-reading ${modifier}`;
          const term = document.createElement("dt");
          term.textContent = label;
          const description = document.createElement("dd");
          description.textContent = value;
          reading.append(term, description);
          reportReadings.append(reading);
        };
        addReading("Water depth", String(properties.depthLabel ?? "Unknown"), "is-depth");
        addReading("Vehicle access", String(properties.vehicleAccessLabel ?? "Unknown"), "is-access");

        const reportMeta = document.createElement("div");
        reportMeta.className = "community-report-meta";
        const reportMetaDot = document.createElement("span");
        reportMetaDot.setAttribute("aria-hidden", "true");
        const timeLine = document.createElement("time");
        const reportedAt = new Date(String(properties.createdAt ?? ""));
        timeLine.textContent = Number.isNaN(reportedAt.valueOf())
          ? "Community report"
          : `Reported ${reportedAt.toLocaleString("en-PH", { dateStyle: "medium", timeStyle: "short" })}`;
        if (!Number.isNaN(reportedAt.valueOf())) timeLine.dateTime = reportedAt.toISOString();
        reportMeta.append(reportMetaDot, timeLine);

        const confirmBlock = document.createElement("div");
        confirmBlock.className = "community-report-confirm";

        let currentStillCount = Number(properties.stillFloodedCount ?? 1);
        let currentClearedCount = Number(properties.clearedCount ?? 0);
        let currentVote = userVotesRef.current[reportId];

        confirmBlock.innerHTML = `
          <p class="community-report-confirm-title">Still like this? Confirming keeps it on the map for longer.</p>
          <div class="community-report-confirm-actions">
            <button type="button" class="community-report-confirm-btn is-flooded${currentVote === "still-flooded" ? " is-active" : ""}" data-btn="flooded">
              <span class="community-report-material-icon confirm-icon" aria-hidden="true">water_drop</span>
              <span class="confirm-label">Still flooded</span>
              <span class="confirm-count" data-count="flooded">${currentStillCount}</span>
            </button>
            <button type="button" class="community-report-confirm-btn is-cleared${currentVote === "cleared" ? " is-active" : ""}" data-btn="cleared">
              <span class="community-report-material-icon confirm-icon" aria-hidden="true">check</span>
              <span class="confirm-label">Cleared</span>
              <span class="confirm-count" data-count="cleared">${currentClearedCount}</span>
            </button>
          </div>
        `;

        const floodedBtn = confirmBlock.querySelector<HTMLButtonElement>('[data-btn="flooded"]');
        const clearedBtn = confirmBlock.querySelector<HTMLButtonElement>('[data-btn="cleared"]');
        const floodedCountEl = confirmBlock.querySelector<HTMLElement>('[data-count="flooded"]');
        const clearedCountEl = confirmBlock.querySelector<HTMLElement>('[data-count="cleared"]');

        if (floodedBtn && clearedBtn && floodedCountEl && clearedCountEl) {
          floodedBtn.addEventListener("click", () => {
            handleVoteReportRef.current(reportId, "still-flooded");
            if (currentVote !== "still-flooded") {
              currentStillCount += 1;
              if (currentVote === "cleared") {
                currentClearedCount = Math.max(0, currentClearedCount - 1);
              }
              currentVote = "still-flooded";
              floodedBtn.classList.add("is-active");
              clearedBtn.classList.remove("is-active");
              floodedCountEl.textContent = String(currentStillCount);
              clearedCountEl.textContent = String(currentClearedCount);
            }
          });

          clearedBtn.addEventListener("click", () => {
            handleVoteReportRef.current(reportId, "cleared");
            if (currentVote !== "cleared") {
              currentClearedCount += 1;
              if (currentVote === "still-flooded") {
                currentStillCount = Math.max(0, currentStillCount - 1);
              }
              currentVote = "cleared";
              clearedBtn.classList.add("is-active");
              floodedBtn.classList.remove("is-active");
              clearedCountEl.textContent = String(currentClearedCount);
              floodedCountEl.textContent = String(currentStillCount);
            }
          });
        }

        popupContent.append(reportKicker, locationHeading, reportReadings, reportMeta, confirmBlock);

        new mapboxgl.Popup({
          className: "community-report-map-popup",
          closeButton: true,
          closeOnClick: true,
          maxWidth: "340px",
          offset: 14
        })
          .setLngLat((feature.geometry.coordinates as [number, number]).slice() as [number, number])
          .setDOMContent(popupContent)
          .addTo(map);
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

    map.getCanvas().style.cursor = "default";
  }, [analysis, mapLoaded]);

  const resetFocusView = useCallback(() => {
    const map = mapRef.current;
    if (!map) return;

    map.flyTo({
      center: DEFAULT_MAP_CENTER,
      zoom: DEFAULT_MAP_ZOOM,
      pitch: mapViewMode === "3d" ? 58 : 0,
      bearing: mapViewMode === "3d" ? -18 : 0,
      duration: 900
    });
  }, [mapViewMode]);

  // Both the crosshair control and the flood report share this single request so
  // they can never disagree about where the device is. It returns a cancel
  // function; exactly one of onSuccess/onFailure fires unless cancelled first.
  const requestDeviceLocation = useCallback(
    (
      onSuccess: (position: GeolocationPosition) => void,
      onFailure: (reason: DeviceLocationFailureReason) => void,
      onProgress?: (accuracyM: number) => void
    ) => {
      if (!window.isSecureContext || !("geolocation" in navigator)) {
        onFailure("unsupported");
        return () => { };
      }

      // Replay the fix the other control just resolved so the crosshair and the
      // flood report can never show two different points for the same user.
      const lastFix = lastDeviceLocationRef.current;
      if (lastFix && Date.now() - lastFix.receivedAt <= DEVICE_LOCATION_MAX_AGE_MS) {
        onSuccess(lastFix.position);
        return () => { };
      }

      let bestPosition: GeolocationPosition | null = null;
      let emptyHandedReason: DeviceLocationFailureReason = "timeout";
      let watchId: number | null = null;
      let graceTimeoutId: number | null = null;
      let hardTimeoutId: number | null = null;
      let finished = false;

      const cleanup = () => {
        if (watchId !== null) {
          navigator.geolocation.clearWatch(watchId);
          watchId = null;
        }
        if (graceTimeoutId !== null) {
          window.clearTimeout(graceTimeoutId);
          graceTimeoutId = null;
        }
        if (hardTimeoutId !== null) {
          window.clearTimeout(hardTimeoutId);
          hardTimeoutId = null;
        }
      };

      const finish = (fallbackReason: DeviceLocationFailureReason) => {
        if (finished) return;
        finished = true;
        cleanup();

        if (bestPosition) {
          lastDeviceLocationRef.current = { position: bestPosition, receivedAt: Date.now() };
          onSuccess(bestPosition);
        } else {
          onFailure(fallbackReason);
        }
      };

      hardTimeoutId = window.setTimeout(() => finish(emptyHandedReason), DEVICE_LOCATION_REQUEST_TIMEOUT_MS);

      const handlePosition = (position: GeolocationPosition) => {
        if (finished) return;
        const { longitude, latitude, accuracy } = position.coords;
        if (
          !Number.isFinite(longitude) ||
          !Number.isFinite(latitude) ||
          !Number.isFinite(accuracy) ||
          accuracy < 0
        ) {
          return;
        }

        if (bestPosition && accuracy >= bestPosition.coords.accuracy) return;
        bestPosition = position;
        onProgress?.(accuracy);

        if (accuracy <= DEVICE_LOCATION_TARGET_ACCURACY_M) {
          finish("timeout");
          return;
        }

        // A usable-but-rough fix settles after a short grace period; rougher
        // Wi-Fi/cell estimates wait out the full window for a GPS lock.
        if (graceTimeoutId !== null) {
          window.clearTimeout(graceTimeoutId);
          graceTimeoutId = null;
        }
        if (accuracy <= DEVICE_LOCATION_MAX_USABLE_ACCURACY_M) {
          graceTimeoutId = window.setTimeout(() => finish("timeout"), DEVICE_LOCATION_REFINEMENT_GRACE_MS);
        }
      };

      const handleError = (locationError: GeolocationPositionError) => {
        if (finished) return;
        if (locationError.code === locationError.PERMISSION_DENIED) {
          finished = true;
          cleanup();
          onFailure("denied");
          return;
        }
        // Unavailable/timeout from one provider is often transient while the
        // watch is still running, so it never ends the search early — it only
        // decides what the hard cap reports if no fix ever arrives.
        if (locationError.code === locationError.POSITION_UNAVAILABLE) {
          emptyHandedReason = "unavailable";
        }
      };

      // Fast low-accuracy one-shot so the caller sees an estimate immediately;
      // it can never finish the search early because it stays above the target.
      navigator.geolocation.getCurrentPosition(handlePosition, handleError, {
        enableHighAccuracy: false,
        timeout: DEVICE_LOCATION_REQUEST_TIMEOUT_MS,
        maximumAge: DEVICE_LOCATION_MAX_AGE_MS
      });

      watchId = navigator.geolocation.watchPosition(handlePosition, handleError, {
        enableHighAccuracy: true,
        timeout: DEVICE_LOCATION_REQUEST_TIMEOUT_MS,
        maximumAge: 0
      });

      return () => {
        finished = true;
        cleanup();
      };
    },
    []
  );

  const locateDevice = useCallback(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) {
      setStatus("The map is still loading. Try locating again in a moment.");
      return;
    }

    locateDeviceCancelRef.current?.();
    setIsLocatingDevice(true);
    setStatus("Finding your location...");

    locateDeviceCancelRef.current = requestDeviceLocation(
      (position) => {
        setIsLocatingDevice(false);
        const { longitude, latitude, accuracy } = position.coords;

        if (!deviceLocationMarkerRef.current) {
          const markerElement = document.createElement("div");
          markerElement.className = "device-location-marker";
          markerElement.setAttribute("aria-hidden", "true");
          deviceLocationMarkerRef.current = new mapboxgl.Marker({ element: markerElement })
            .setLngLat([longitude, latitude])
            .addTo(map);
        } else {
          deviceLocationMarkerRef.current.setLngLat([longitude, latitude]);
        }

        map.easeTo({
          center: [longitude, latitude],
          zoom: Math.max(map.getZoom(), accuracy <= DEVICE_LOCATION_GOOD_ACCURACY_M ? 16 : 13.5),
          duration: 900
        });

        setStatus(
          Number.isFinite(accuracy)
            ? `Centered on your location (accurate to about ${formatAccuracy(accuracy)}).`
            : "Centered on your location."
        );
      },
      (reason) => {
        setIsLocatingDevice(false);
        setStatus(`${DEVICE_LOCATION_FAILURE_MESSAGES[reason]} Try again in a moment.`);
      },
      (accuracyM) => {
        setStatus(`Finding your location... best fix so far ±${formatAccuracy(accuracyM)}.`);
      }
    );
  }, [mapLoaded, requestDeviceLocation]);

  // When location permission was already granted, the default view opens on the
  // user's position; "prompt" or "denied" keeps the Albay overview so the first
  // load never raises a permission dialog on its own.
  useEffect(() => {
    if (!mapLoaded || hasAutoCenteredOnDeviceRef.current) return;
    if (!window.isSecureContext || !("geolocation" in navigator) || !navigator.permissions?.query) {
      return;
    }

    let cancelled = false;
    navigator.permissions
      .query({ name: "geolocation" })
      .then((result) => {
        if (cancelled || result.state !== "granted" || hasAutoCenteredOnDeviceRef.current) return;
        hasAutoCenteredOnDeviceRef.current = true;
        locateDevice();
      })
      .catch(() => { });

    return () => {
      cancelled = true;
    };
  }, [mapLoaded, locateDevice]);

  const toggleMapViewMode = useCallback(() => {
    const nextMode = mapViewMode === "3d" ? "2d" : "3d";
    setMapViewMode(nextMode);
    mapRef.current?.easeTo({
      pitch: nextMode === "3d" ? 58 : 0,
      bearing: nextMode === "3d" ? -18 : 0,
      duration: 700
    });
  }, [mapViewMode]);

  // Names the barangay containing the point, or the nearest one when the point
  // falls in a gap of the simplified boundaries (coastlines, reclaimed land).
  // Labeling only — it never moves or rejects the pinned coordinates.
  const describeFloodReportArea = useCallback(
    (longitude: number, latitude: number) => {
      const point = turf.point([longitude, latitude]);
      const containingBarangay = barangayData.features.find((feature) =>
        turf.booleanPointInPolygon(point, feature)
      );

      if (containingBarangay) {
        return `${containingBarangay.properties.name}, ${formatMunicipalityName(
          containingBarangay.properties.municipalityName
        )}, Albay`;
      }

      // Distance to the polygon boundary, not the centroid — centroid distance
      // biases toward small barangays and can name the wrong neighbor.
      let nearestFeature: BarangayFeature | null = null;
      let nearestDistanceKm = Number.POSITIVE_INFINITY;

      for (const feature of barangayData.features) {
        const distanceKm = turf.pointToPolygonDistance(point, feature, { units: "kilometers" });
        if (distanceKm < nearestDistanceKm) {
          nearestDistanceKm = distanceKm;
          nearestFeature = feature;
        }
      }

      if (!nearestFeature) return null;

      return `Near ${nearestFeature.properties.name}, ${formatMunicipalityName(
        nearestFeature.properties.municipalityName
      )}, Albay`;
    },
    [barangayData]
  );

  const updateFloodReportPin = useCallback(
    (
      longitude: number,
      latitude: number,
      selectionMethod: FloodReportLocation["selectionMethod"],
      accuracyM = 0
    ) => {
      // The pinned coordinates are authoritative and are recorded exactly as
      // given; the barangay name is a label derived from them, never a gate.
      setFloodReportLocation({
        longitude,
        latitude,
        accuracyM,
        areaLabel:
          describeFloodReportArea(longitude, latitude) ??
          `${latitude.toFixed(5)}, ${longitude.toFixed(5)}`,
        selectionMethod
      });
      setFloodReportError(null);
      reportMarkerRef.current?.setLngLat([longitude, latitude]);
    },
    [describeFloodReportArea]
  );

  const stopFloodReportLocationRequest = useCallback(() => {
    reportLocationCancelRef.current?.();
    reportLocationCancelRef.current = null;
    if (reportLocationElapsedIntervalRef.current !== null) {
      window.clearInterval(reportLocationElapsedIntervalRef.current);
      reportLocationElapsedIntervalRef.current = null;
    }
  }, []);

  const beginManualFloodReportPlacement = useCallback(
    (message?: string) => {
      const map = mapRef.current;
      if (!map) {
        setFloodReportMode("closed");
        setFloodReportError("The map is still loading. Try again in a moment.");
        return;
      }

      const center = map.getCenter();
      updateFloodReportPin(center.lng, center.lat, "map-pin");
      setFloodReportError(message ?? null);
      setFloodReportMode("placing");
      map.easeTo({
        center: [center.lng, center.lat],
        zoom: Math.max(map.getZoom(), 14.5),
        pitch: mapViewMode === "3d" ? 58 : 0,
        bearing: mapViewMode === "3d" ? -18 : 0,
        duration: 700
      });
    },
    [mapViewMode, updateFloodReportPin]
  );

  const chooseFloodReportLocationManually = useCallback(() => {
    stopFloodReportLocationRequest();
    reportLocationRequestIdRef.current += 1;
    beginManualFloodReportPlacement("Tap the map or drag the pin to the flooded spot.");
  }, [beginManualFloodReportPlacement, stopFloodReportLocationRequest]);

  const startFloodReport = useCallback(() => {
    if (!mapLoaded || !mapRef.current) {
      setFloodReportError("The map is still loading. Try again in a moment.");
      return;
    }

    stopFloodReportLocationRequest();
    const requestId = ++reportLocationRequestIdRef.current;
    setFloodReportDepth(null);
    setFloodReportVehicleAccess(null);
    setFloodReportLocation(null);
    setFloodReportError(null);
    setFloodReportLocationStatus("Requesting precise device location…");
    setFloodReportLocationElapsedMs(0);
    setFloodReportLocationDenied(false);
    setIsFloodReportSubmitted(false);
    setFloodReportMode("locating");

    const startedAt = Date.now();
    reportLocationElapsedIntervalRef.current = window.setInterval(() => {
      if (requestId !== reportLocationRequestIdRef.current) return;
      setFloodReportLocationElapsedMs(Date.now() - startedAt);
    }, 250);

    reportLocationCancelRef.current = requestDeviceLocation(
      (position) => {
        if (requestId !== reportLocationRequestIdRef.current) return;
        reportLocationCancelRef.current = null;
        stopFloodReportLocationRequest();

        const { longitude, latitude, accuracy } = position.coords;
        updateFloodReportPin(longitude, latitude, "device-location", accuracy);

        const roundedAccuracy = Math.max(1, Math.round(accuracy));
        setFloodReportError(
          accuracy <= DEVICE_LOCATION_GOOD_ACCURACY_M
            ? `Device location found within approximately ±${roundedAccuracy} m. Verify the pin before continuing.`
            : accuracy <= DEVICE_LOCATION_MAX_USABLE_ACCURACY_M
              ? `Your device could only estimate this location within ±${roundedAccuracy} m. Retry outdoors or adjust the pin.`
              : `Your browser only shared an approximate location (±${formatAccuracy(accuracy)}), so the pin may be far from where you are. On a phone, allow “Precise Location” for your browser in the phone's location settings and retry — or drag the pin to the exact flooded spot.`
        );
        setFloodReportMode("placing");
        mapRef.current?.easeTo({
          center: [longitude, latitude],
          zoom: accuracy <= DEVICE_LOCATION_GOOD_ACCURACY_M ? 17 : accuracy <= DEVICE_LOCATION_MAX_USABLE_ACCURACY_M ? 15.5 : 13.5,
          pitch: mapViewMode === "3d" ? 58 : 0,
          bearing: mapViewMode === "3d" ? -18 : 0,
          duration: 700
        });
      },
      (reason) => {
        if (requestId !== reportLocationRequestIdRef.current) return;
        reportLocationCancelRef.current = null;
        stopFloodReportLocationRequest();

        if (reason === "denied") {
          setFloodReportLocationDenied(true);
        }

        beginManualFloodReportPlacement(
          `${DEVICE_LOCATION_FAILURE_MESSAGES[reason]} Tap the map to place the report instead.`
        );
      },
      (accuracyM) => {
        if (requestId !== reportLocationRequestIdRef.current) return;
        setFloodReportLocationStatus(
          accuracyM <= DEVICE_LOCATION_TARGET_ACCURACY_M
            ? `Precise GPS fix found (±${formatAccuracy(accuracyM)}).`
            : accuracyM <= DEVICE_LOCATION_MAX_USABLE_ACCURACY_M
              ? `Improving GPS accuracy… best reading ±${formatAccuracy(accuracyM)}.`
              : `Approximate location received (±${formatAccuracy(accuracyM)}). Waiting for a precise GPS fix…`
        );
      }
    );
  }, [beginManualFloodReportPlacement, mapLoaded, mapViewMode, requestDeviceLocation, stopFloodReportLocationRequest, updateFloodReportPin]);

  const closeFloodReport = useCallback(() => {
    stopFloodReportLocationRequest();
    reportLocationRequestIdRef.current += 1;
    reportMarkerRef.current?.remove();
    reportMarkerRef.current = null;
    setFloodReportMode("closed");
    setFloodReportLocation(null);
    setFloodReportDepth(null);
    setFloodReportVehicleAccess(null);
    setFloodReportError(null);
    setIsSubmittingFloodReport(false);
    setIsFloodReportSubmitted(false);
    resetFocusView();
    window.requestAnimationFrame(() => reportTriggerRef.current?.focus());
  }, [resetFocusView, stopFloodReportLocationRequest]);

  const confirmFloodReportLocation = useCallback(() => {
    if (!floodReportLocation) {
      setFloodReportError("Tap a spot on the map before continuing.");
      return;
    }

    reportMarkerRef.current?.remove();
    reportMarkerRef.current = null;
    setFloodReportError(null);
    setFloodReportMode("details");
  }, [floodReportLocation]);

  const submitSelectedFloodReport = useCallback(async () => {
    if (!floodReportLocation || !floodReportDepth || !floodReportVehicleAccess) return;

    setIsSubmittingFloodReport(true);
    setFloodReportError(null);
    try {
      await submitFloodReport({
        ...floodReportLocation,
        depth: floodReportDepth,
        vehicleAccess: floodReportVehicleAccess
      });
      setIsFloodReportSubmitted(true);
    } catch (submissionError) {
      setFloodReportError(getFloodReportSubmissionErrorMessage(submissionError));
    } finally {
      setIsSubmittingFloodReport(false);
    }
  }, [floodReportDepth, floodReportLocation, floodReportVehicleAccess]);

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
    initializeMap();
  }, [barangayData.features.length, initializeMap]);

  useEffect(() => {
    if (!isFirebaseConfigured) return;

    try {
      return subscribeToFloodReports(
        (reports) => {
          setCommunityFloodReports(reports);
          setCommunityFloodReportError(null);
        },
        setCommunityFloodReportError
      );
    } catch (subscriptionError) {
      setCommunityFloodReportError(
        (subscriptionError as Error).message || "Community flood reports are temporarily unavailable."
      );
    }
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const source = map.getSource("community-flood-reports") as mapboxgl.GeoJSONSource | undefined;
    source?.setData(communityFloodReportGeoJson);
  }, [communityFloodReportGeoJson, mapLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded || communityFloodReports.length === 0) return;

    const heatLayerIds = FLOOD_REPORT_HEAT_LAYER_IDS.filter((layerId) => map.getLayer(layerId));
    if (heatLayerIds.length === 0) return;

    const pointsLayerId = "community-flood-report-points";

    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      heatLayerIds.forEach((layerId) => {
        map.setPaintProperty(layerId, "heatmap-opacity", 0.75);
        map.setPaintProperty(layerId, "heatmap-radius", floodReportHeatRadius(1));
      });
      if (map.getLayer(pointsLayerId)) {
        map.setPaintProperty(pointsLayerId, "circle-radius", floodReportCoreRadius(1));
        map.setPaintProperty(pointsLayerId, "circle-stroke-width", floodReportCoreStrokeWidth(1));
      }
      return;
    }

    let animationFrame = 0;
    const breathDurationMs = 2_800;

    const animateFloodReportHeat = (time: number) => {
      const phase = ((time % breathDurationMs) / breathDurationMs) * Math.PI * 2;
      const breath = (1 - Math.cos(phase)) / 2;
      const radiusScale = 0.88 + breath * 0.24;
      const opacity = 0.6 + breath * 0.28;
      const coreScale = 0.95 + breath * 0.2;

      heatLayerIds.forEach((layerId) => {
        if (!map.getLayer(layerId)) return;
        map.setPaintProperty(layerId, "heatmap-radius", floodReportHeatRadius(radiusScale));
        map.setPaintProperty(layerId, "heatmap-opacity", opacity);
      });

      if (map.getLayer(pointsLayerId)) {
        map.setPaintProperty(pointsLayerId, "circle-radius", floodReportCoreRadius(coreScale));
        map.setPaintProperty(pointsLayerId, "circle-stroke-width", floodReportCoreStrokeWidth(coreScale));
      }

      animationFrame = window.requestAnimationFrame(animateFloodReportHeat);
    };

    animationFrame = window.requestAnimationFrame(animateFloodReportHeat);

    return () => window.cancelAnimationFrame(animationFrame);
  }, [communityFloodReports.length, mapLoaded]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapLoaded) return;

    const accuracySource = map.getSource("flood-report-location-accuracy") as mapboxgl.GeoJSONSource | undefined;
    const accuracyCircle =
      floodReportMode === "placing" &&
        floodReportLocation?.selectionMethod === "device-location" &&
        floodReportLocation.accuracyM > 0
        ? turf.circle(
          [floodReportLocation.longitude, floodReportLocation.latitude],
          Math.min(floodReportLocation.accuracyM, 10_000) / 1_000,
          { steps: 64, units: "kilometers" }
        )
        : null;
    accuracySource?.setData(
      accuracyCircle ? turf.featureCollection([accuracyCircle]) : (toFeatureCollection() as FeatureCollection)
    );

    if (floodReportMode !== "placing" || !floodReportLocation) {
      reportMarkerRef.current?.remove();
      reportMarkerRef.current = null;
      return;
    }

    if (!reportMarkerRef.current) {
      reportMarkerRef.current = new mapboxgl.Marker({ color: "#2f5fe3", draggable: true })
        .setLngLat([floodReportLocation.longitude, floodReportLocation.latitude])
        .addTo(map);
    } else {
      reportMarkerRef.current.setLngLat([floodReportLocation.longitude, floodReportLocation.latitude]);
    }

    const handleMapClick = (event: mapboxgl.MapMouseEvent) => {
      updateFloodReportPin(event.lngLat.lng, event.lngLat.lat, "map-pin");
    };
    const handleMarkerDragEnd = () => {
      const markerPosition = reportMarkerRef.current?.getLngLat();
      if (!markerPosition) return;
      updateFloodReportPin(markerPosition.lng, markerPosition.lat, "map-pin");
    };

    map.on("click", handleMapClick);
    reportMarkerRef.current.on("dragend", handleMarkerDragEnd);

    return () => {
      map.off("click", handleMapClick);
      reportMarkerRef.current?.off("dragend", handleMarkerDragEnd);
    };
  }, [floodReportLocation, floodReportMode, mapLoaded, updateFloodReportPin]);

  useEffect(() => {
    return () => {
      if (reportMarkerRef.current) {
        reportMarkerRef.current.remove();
        reportMarkerRef.current = null;
      }

      if (deviceLocationMarkerRef.current) {
        deviceLocationMarkerRef.current.remove();
        deviceLocationMarkerRef.current = null;
      }

      locateDeviceCancelRef.current?.();
      locateDeviceCancelRef.current = null;

      stopFloodReportLocationRequest();

      if (mapRef.current) {
        mapRef.current.remove();
        mapRef.current = null;
      }
    };
  }, [stopFloodReportLocationRequest]);

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
    if (!weather) return;
    updateMapLayers();
  }, [weather, analysis, mapLoaded, safeHours, updateMapLayers]);

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

    setVisibility(["tomtom-traffic-tiles"], layerVisibility.traffic && trafficProvider === "tomtom");
    setVisibility(
      ["traffic-flow-casing", "traffic-flow-line"],
      layerVisibility.traffic && trafficProvider === "mapbox"
    );
  }, [layerVisibility, mapLoaded, trafficProvider]);

  useEffect(() => {
    let cancelled = false;

    const checkTrafficProvider = async () => {
      try {
        const response = await fetch("/api/traffic/status", { cache: "no-store" });
        if (!response.ok) return;
        const payload = (await response.json()) as { provider?: unknown };
        if (cancelled) return;
        if (payload.provider === "tomtom" || payload.provider === "mapbox") {
          setTrafficProvider(payload.provider);
        }
      } catch {
        // Keep the current provider; the next poll will retry.
      }
    };

    checkTrafficProvider();
    const pollHandle = window.setInterval(checkTrafficProvider, 5 * 60 * 1000);

    return () => {
      cancelled = true;
      window.clearInterval(pollHandle);
    };
  }, []);

  useEffect(() => {
    const canvas = rainCanvasRef.current;
    const host = canvas?.parentElement;
    if (!canvas || !host) return;

    const context = canvas.getContext("2d");
    if (!context) return;

    const map = mapRef.current;
    const activeAnalysis = analysis;
    const rainClipGeometries: Array<Polygon | MultiPolygon> = activeAnalysis
      ? [activeAnalysis.boundary.geometry]
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
  }, [analysis, layerVisibility.rainAnimation, mapLoaded]);

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
  const currentRainIntervalMinutes = Math.max(1, Math.round((weather?.current.interval ?? 3600) / 60));
  const selectedRainRateBasis = `Equivalent hourly rate derived from the current ${currentRainIntervalMinutes}-minute modeled precipitation`;
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

  const loadingStage = barangayData.features.length === 0 && !barangayError
    ? 0
    : !weather
      ? 1
      : !mapLoaded
        ? 2
        : 3;
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

  const renderOfficialRainObservationContent = () => (
    <>
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
          ? `${featuredOfficialGauge.site_name} · ${featuredOfficialGauge.observed_at
            ? `preceding hour at ${formatTime(featuredOfficialGauge.observed_at)}`
            : "no observation time"
          } · ${featuredOfficialGaugeState}`
          : officialRainfallError || "Loading official Albay station observations…"}
      </small>
      <small>Station-specific measurement; not substituted into the area-wide model calculation.</small>
    </>
  );

  return (
    <main className="district-forward-page">
      <section
        className="district-forward-shell"
        aria-label="Source-backed rainfall dashboard"
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
                <h2>
                  {activeLoadingStage.title}
                  <span className="district-loading-cursor" aria-hidden="true" />
                </h2>
                <span>{activeLoadingStage.detail}</span>
              </div>

              <div className="district-loading-progress-row">
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
                <span className="district-loading-progress-value" aria-hidden="true">
                  {String(loadingProgress).padStart(3, "0")}%
                </span>
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

        {floodReportMode === "details" && floodReportLocation ? (
          <FloodReportDialog
            location={floodReportLocation}
            depth={floodReportDepth}
            vehicleAccess={floodReportVehicleAccess}
            isSubmitting={isSubmittingFloodReport}
            submitted={isFloodReportSubmitted}
            error={floodReportError}
            onClose={closeFloodReport}
            onEditLocation={() => {
              setIsFloodReportSubmitted(false);
              setFloodReportError(null);
              setFloodReportMode("placing");
            }}
            onDepthChange={setFloodReportDepth}
            onVehicleAccessChange={setFloodReportVehicleAccess}
            onSubmit={() => void submitSelectedFloodReport()}
          />
        ) : null}

        {isOfficialRainDialogOpen ? (
          <div
            className="official-rain-dialog-backdrop"
            onClick={(event) => {
              if (event.target === event.currentTarget) closeOfficialRainDialog();
            }}
          >
            <section
              id="official-rain-dialog"
              className="official-rain-dialog"
              role="dialog"
              aria-modal="true"
              aria-labelledby="official-rain-dialog-title"
              onKeyDown={(event) => {
                if (event.key === "Tab") {
                  event.preventDefault();
                  officialRainDialogCloseRef.current?.focus();
                }
              }}
            >
              <header className="official-rain-dialog-header">
                <div>
                  <span>Official station reading</span>
                  <h2 id="official-rain-dialog-title">Rain-gauge observation</h2>
                </div>
                <button
                  ref={officialRainDialogCloseRef}
                  type="button"
                  onClick={() => closeOfficialRainDialog()}
                  aria-label="Close rain-gauge observation"
                >
                  ×
                </button>
              </header>
              <div
                className={`official-rain-observation official-rain-observation-dialog ${featuredOfficialGaugeState}`}
                aria-label="Latest official PAGASA rain-gauge observation in Albay"
              >
                {renderOfficialRainObservationContent()}
              </div>
              <div className="official-rain-context-notes" aria-label="Map interpretation notes">
                <p>
                  Rain dots are an illustrative animation driven by the displayed model rate; individual dots are not measurements.
                </p>
                <p>
                  Rainfall coverage uses the complete selected {selectedAreaLevel.toLowerCase()} boundary.
                </p>
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
          <div className="district-forward-header-actions">
            <Link href="/data-sources" className="district-forward-sources-link">
              <span className="sources-label-wide">Data Sources</span>
              <span className="sources-label-compact">Sources</span>
            </Link>
            <button
              ref={officialRainDialogTriggerRef}
              type="button"
              className={`official-rain-observation-trigger ${featuredOfficialGaugeState}`}
              onClick={() => setIsOfficialRainDialogOpen(true)}
              aria-label="Show latest official PAGASA rain-gauge observation"
              aria-haspopup="dialog"
              aria-expanded={isOfficialRainDialogOpen}
              aria-controls={isOfficialRainDialogOpen ? "official-rain-dialog" : undefined}
            >
              <span aria-hidden="true">!</span>
            </button>
          </div>
        </header>

        <div
          className="district-forward-grid"
        >
          <aside className="district-forward-sidebar" aria-label="Controls and snapshot metrics">
            <h4 className="district-forward-title">Flood monitoring workspace</h4>
            <p className="district-forward-lede">
              Numerical weather-model values for one representative point, not observations for the full selected area or an official flood warning.
            </p>

            <div
              className={`official-rain-observation official-rain-observation-inline ${featuredOfficialGaugeState}`}
              aria-label="Latest official PAGASA rain-gauge observation in Albay"
            >
              {renderOfficialRainObservationContent()}
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
                      ? `${formatNumber(analysis.estimatedWaterLiters, 0)} liters of modeled rainfall over the latest 24 hours, assuming uniform rain across the selected land boundary`
                      : undefined
                  }
                  aria-label={analysis ? `${formatNumber(analysis.estimatedWaterLiters, 0)} liters` : undefined}
                >
                  {analysis ? `${formatCompactNumber(analysis.estimatedWaterLiters)} L` : "—"}
                </strong>
                <small>24-h rainfall volume</small>
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
                  title={analysis ? `${formatNumber(analysis.landAreaKm2)} square kilometers` : undefined}
                  aria-label={analysis ? `${formatNumber(analysis.landAreaKm2)} square kilometers` : undefined}
                >
                  {analysis ? `${formatCompactNumber(analysis.landAreaKm2)} km²` : "—"}
                </strong>
                <small>Selected land area</small>
              </div>
              <div className="district-forward-cell">
                <strong>{weather ? getWeatherLabel(weather.current.weather_code) : "—"}</strong>
                <small>Current model weather</small>
              </div>
            </div>

            <div className="district-forward-controlblock">
              <fieldset className="district-forward-layers">
                <legend>Map layers</legend>
                <div className="district-forward-layer-content">
                  <div className="layer-options">
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
                        checked={layerVisibility.traffic}
                        onChange={(event) =>
                          setLayerVisibility((current) => ({ ...current, traffic: event.target.checked }))
                        }
                      />
                      <span>Live road traffic</span>
                      <strong>Live</strong>
                    </label>
                  </div>
                </div>
              </fieldset>
            </div>

            <div className="district-forward-controlblock district-forward-hotlines-block">
              <h2>Emergency hotlines</h2>
              <ul className="district-forward-hotlines" aria-label="Albay emergency hotlines">
                {ALBAY_EMERGENCY_HOTLINES.map((hotline) => (
                  <li key={hotline.tel} className={"primary" in hotline && hotline.primary ? "is-primary" : undefined}>
                    <span>{hotline.label}</span>
                    <a href={`tel:${hotline.tel}`}>{hotline.display}</a>
                  </li>
                ))}
              </ul>
              <p className="district-forward-hotlines-note">
                Save these before a storm. If a line is unreachable, call 911.
              </p>
            </div>

            <div
              className={`live-data-status live-data-status-sidebar ${liveFeedState}`}
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
          </aside>

          <section
            className={`district-forward-map${floodReportMode === "placing" || floodReportMode === "locating" ? " flood-report-placement-active" : ""}`}
            aria-label="Albay Province map view"
          >
            <div
              ref={mapContainerRef}
              id="map"
              role="application"
              aria-label="Interactive 3D satellite map showing modeled rainfall and contextual water networks across Albay Province"
            />
            <canvas ref={rainCanvasRef} className="rain-particle-layer" aria-hidden="true" />

            <div className="map-view-controls" role="group" aria-label="Map view controls">
              <button type="button" aria-label="Zoom in" onClick={() => mapRef.current?.zoomIn()}>
                +
              </button>
              <button type="button" aria-label="Zoom out" onClick={() => mapRef.current?.zoomOut()}>
                −
              </button>
              <button
                type="button"
                className="map-view-mode-toggle"
                aria-label={mapViewMode === "3d" ? "Switch to 2D view" : "Switch to 3D view"}
                aria-pressed={mapViewMode === "3d"}
                onClick={toggleMapViewMode}
              >
                {mapViewMode === "3d" ? "2D" : "3D"}
              </button>
              <button type="button" aria-label="Reset map to the default view" onClick={resetFocusView}>
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <path d="M12 2.8 19 20.4l-7-4.1-7 4.1L12 2.8Z" fill="currentColor" />
                </svg>
              </button>
              <button
                type="button"
                className={`map-view-locate${isLocatingDevice ? " is-locating" : ""}`}
                aria-label="Show my location"
                aria-busy={isLocatingDevice}
                onClick={locateDevice}
              >
                <svg viewBox="0 0 24 24" aria-hidden="true" focusable="false">
                  <circle
                    cx="12"
                    cy="12"
                    r="5.2"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.9"
                  />
                  <circle cx="12" cy="12" r="2" fill="currentColor" />
                  <path
                    d="M12 1.6v3.4M12 19v3.4M22.4 12H19M5 12H1.6"
                    fill="none"
                    stroke="currentColor"
                    strokeWidth="1.9"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>

            {floodReportMode === "locating" ? (
              <div className="flood-report-locating" role="status" aria-live="polite">
                <span className="flood-report-locating-pulse" aria-hidden="true" />
                <div>
                  <strong>Finding your location</strong>
                  <span>{floodReportLocationStatus}</span>
                  <div className="flood-report-locating-progress" aria-hidden="true">
                    <div
                      className="flood-report-locating-progress-bar"
                      style={{
                        width: `${Math.min(100, (floodReportLocationElapsedMs / DEVICE_LOCATION_REQUEST_TIMEOUT_MS) * 100)}%`
                      }}
                    />
                  </div>
                  <span>
                    {Math.min(
                      Math.floor(floodReportLocationElapsedMs / 1000),
                      Math.floor(DEVICE_LOCATION_REQUEST_TIMEOUT_MS / 1000)
                    )}
                    s / {Math.floor(DEVICE_LOCATION_REQUEST_TIMEOUT_MS / 1000)}s
                  </span>
                </div>
                <button type="button" onClick={chooseFloodReportLocationManually}>Choose on map</button>
                <button type="button" className="is-quiet" onClick={closeFloodReport}>Cancel</button>
              </div>
            ) : null}

            {floodReportMode === "placing" ? (
              <>
                <div
                  className={`flood-report-placement-message${floodReportLocationDenied ? " is-denied" : ""}`}
                  role="status"
                >
                  <strong>{floodReportLocationDenied ? "Location permission blocked" : "Place the report"}</strong>
                  <span>{floodReportError || "Tap the map or drag the pin to the flooded spot."}</span>
                </div>
                <div className="flood-report-placement-actions">
                  <button type="button" className="is-quiet" onClick={closeFloodReport}>
                    <span aria-hidden="true">×</span> Cancel
                  </button>
                  <button type="button" className="is-quiet" onClick={startFloodReport}>
                    <span aria-hidden="true">◎</span> Retry GPS
                  </button>
                  <button
                    type="button"
                    className="is-primary"
                    onClick={confirmFloodReportLocation}
                    disabled={!floodReportLocation}
                  >
                    <span aria-hidden="true">✓</span> Use this spot
                  </button>
                </div>
              </>
            ) : null}

            {floodReportMode === "closed" ? (
              <button
                ref={reportTriggerRef}
                type="button"
                className="flood-report-launch"
                onClick={startFloodReport}
                disabled={!mapLoaded}
                aria-label={mapLoaded ? "Report flood" : "Map is loading"}
                title={mapLoaded ? "Report flood" : "Map is loading"}
              >
                <span aria-hidden="true">+</span>
                {mapLoaded ? "Report flood" : "Map loading"}
              </button>
            ) : null}

            {floodReportMode === "closed" ? (
              <div className="flood-report-map-legend" aria-label="Community flood report depths">
                <div>
                  <strong>Community reports</strong>
                  <span>{communityFloodReports.length > 0 ? `${communityFloodReports.length} active` : "Last 24 hours"}</span>
                </div>
                <ul>
                  <li><span style={{ backgroundColor: "#48b77b" }} />Clear</li>
                  <li><span style={{ backgroundColor: "#50c8bb" }} />Ankle</li>
                  <li><span style={{ backgroundColor: "#f1b934" }} />Knee</li>
                  <li><span style={{ backgroundColor: "#ed8b3c" }} />Waist</li>
                  <li><span style={{ backgroundColor: "#d94640" }} />Chest+</li>
                </ul>
                {communityFloodReportError ? <small title={communityFloodReportError}>Feed unavailable</small> : null}
              </div>
            ) : null}

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
                <span className={layerVisibility.rainAnimation ? "" : "is-hidden"} title="Illustrative animation driven by the modeled rain rate">
                  <span className="district-forward-dot rain" aria-hidden="true" />
                  Rain animation
                </span>
                <span
                  className={layerVisibility.traffic ? "" : "is-hidden"}
                  title="Live road congestion: green free-flowing to red severe"
                >
                  <span
                    className="district-forward-dot"
                    style={{ background: "linear-gradient(90deg, #48b77b, #f1b934, #ed8b3c, #d94640)" }}
                    aria-hidden="true"
                  />
                  Traffic
                </span>
              </div>
            </div>

          </section>
        </div>
      </section>
    </main>
  );
}
