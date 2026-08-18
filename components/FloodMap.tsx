"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import Image from "next/image";
import mapboxgl from "mapbox-gl";
import "mapbox-gl/dist/mapbox-gl.css";
import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, Polygon, Point, LineString, MultiLineString, MultiPolygon } from "geojson";
import FloodLoadingIcon from "./FloodLoadingIcon";

type WeatherResponse = {
  current_units: {
    precipitation: string;
  };
  current: {
    time: string;
    interval?: number;
    temperature_2m: number;
    precipitation: number;
    weather_code: number;
  };
  hourly: {
    time: string[];
    precipitation: number[];
  };
  elevation: number;
  timezone: string;
};

type OverpassElement = {
  type: string;
  id: number;
  geometry?: {
    lat: number;
    lon: number;
  }[];
  tags?: Record<string, string>;
};

type OverpassResponse = {
  elements: OverpassElement[];
};

type HydroGeometry = LineString | Polygon | MultiLineString | MultiPolygon;
type HydroFeature = Feature<HydroGeometry>;
type HydroFeatureCollection = FeatureCollection<HydroGeometry>;

type BarangayProperties = {
  code: string;
  name: string;
  areaSqKm: number;
  municipalityCode: string;
  municipalityName: string;
  provinceCode: string;
  provinceName: string;
};

type BarangayGeometry = Polygon | MultiPolygon;
type BarangayFeature = Feature<BarangayGeometry, BarangayProperties>;
type BarangayFeatureCollection = FeatureCollection<BarangayGeometry, BarangayProperties>;

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
  riskIndex: number;
  riskColor: string;
  selectedForecastHour: number;
  selectedRainRateMmPerHour: number;
  windowStartHour: number;
  windowEndHour: number;
};

type LayerVisibility = {
  barangays: boolean;
  rainZone: boolean;
  rainAnimation: boolean;
  waterways: boolean;
  waterAreas: boolean;
};

type HydrologyStatus = "idle" | "loading" | "ready" | "error";

type RainParticle = {
  x: number;
  y: number;
  radius: number;
  speed: number;
  drift: number;
  opacity: number;
};

const WEATHER_REFRESH_INTERVAL_MS = 5 * 60 * 1000;
const WEATHER_FOCUS_REFRESH_MS = 2 * 60 * 1000;
const WEATHER_STALE_AFTER_MS = 12 * 60 * 1000;
const ALBAY_PROVINCE_CODE = "05005";
// A generous margin keeps Albay's outer islands visible in the pitched 3D view
// while still preventing users from navigating far away from the province.
const ALBAY_MAP_BOUNDS_PADDING_RATIO = 0.3;
const ALBAY_VIEWPORT_FOOTPRINT_ALLOWANCE = 1.15;
const ALBAY_PROVINCE_FOCUS: FocusLocation = {
  lat: 13.1775,
  lng: 123.528,
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

const INITIAL_LOADING_STEPS: ReadonlyArray<{ label: string; title: string; detail: string }> = [
  {
    label: "Area",
    title: "Loading Albay coverage",
    detail: "Preparing province-wide boundaries with Legazpi City as the default focus."
  },
  {
    label: "Weather",
    title: "Syncing rainfall data",
    detail: "Loading measured and forecast precipitation from Open-Meteo."
  },
  {
    label: "3D map",
    title: "Building the terrain view",
    detail: "Loading satellite imagery, elevation terrain, and map controls."
  },
  {
    label: "GIS layers",
    title: "Indexing nearby waterways",
    detail: "Preparing river, stream, waterbody, and administrative boundary geometries."
  }
];

const READY_LOADING_STAGE = {
  title: "Live map ready",
  detail: "Area, rainfall, terrain, and GIS layers are synchronized."
};

const toFeatureCollection = (): HydroFeatureCollection => ({
  type: "FeatureCollection",
  features: []
});

const toBarangayFeatureCollection = (): BarangayFeatureCollection => ({
  type: "FeatureCollection",
  features: []
});

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
  const hydrologyRequestIdRef = useRef(0);
  const lastMapFitRef = useRef("");
  const areaPickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const areaSearchInputRef = useRef<HTMLInputElement | null>(null);
  const [status, setStatus] = useState("Preparing Albay Province data...");
  const [weather, setWeather] = useState<WeatherResponse | null>(null);
  const [weatherError, setWeatherError] = useState<string | null>(null);
  const [isWeatherRefreshing, setIsWeatherRefreshing] = useState(false);
  const [lastWeatherUpdatedAt, setLastWeatherUpdatedAt] = useState<number | null>(null);
  const [isOnline, setIsOnline] = useState(true);
  const [clockNow, setClockNow] = useState<number | null>(null);
  const [radiusKm, setRadiusKm] = useState(0);
  const [hoursWindow, setHoursWindow] = useState(24);
  const [forecastHour, setForecastHour] = useState(0);
  const [isTimelinePlaying, setIsTimelinePlaying] = useState(false);
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
  const [hasFinishedInitialLoad, setHasFinishedInitialLoad] = useState(false);
  const [isMobileLegendOpen, setIsMobileLegendOpen] = useState(false);

  const mapToken = process.env.NEXT_PUBLIC_MAPBOX_TOKEN;
  const barangayOptions = useMemo(
    () => [...barangayData.features].sort((a, b) => barangayNameCollator.compare(a.properties.name, b.properties.name)),
    [barangayData]
  );
  const albayProvinceBounds = useMemo<[number, number, number, number] | null>(() => {
    if (barangayData.features.length === 0) return null;
    return turf.bbox(barangayData) as [number, number, number, number];
  }, [barangayData]);
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
      : `Albay Province · ${municipalityOptions.length || 18} LGUs`;
  const areaOptions = useMemo<AreaOption[]>(() => {
    const provinceOption: AreaOption = {
      key: `province:${ALBAY_PROVINCE_CODE}`,
      level: "province",
      label: "All Albay Province",
      description: `${municipalityOptions.length || 18} cities & municipalities · ${barangayData.features.length || 720} barangays`
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

  const getRiskColor = useCallback((index: number) => {
    if (index < 30) return "#10b981";
    if (index < 50) return "#f59e0b";
    if (index < 70) return "#f97316";
    return "#ef4444";
  }, []);

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
    const date = new Date(isoTime);
    if (Number.isNaN(date.valueOf())) return isoTime;

    return date.toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit"
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
    const estimatedWaterLiters = safeAreaSqM * precipWindowMm;

    const currentRainIntensity = selectedRainRateMmPerHour;
    const actualWindowHours = availableHours.length || 1;
    const hourlyIntensity = precipWindowMm / actualWindowHours;
    const lowElevationPenalty = Math.max(0, (30 - Math.min(weather.elevation, 30)) / 30);
    const intensityScore = Math.min(100, (hourlyIntensity * 8 + currentRainIntensity * 9 + precipWindowMm) * 0.9);
    const riskIndex = Math.round(Math.max(0, Math.min(100, intensityScore + lowElevationPenalty * 12)));

    const riskColor = getRiskColor(riskIndex);

    return {
      radiusKm,
      polygon: circle,
      radiusAreaKm2: safeAreaSqM / 1_000_000,
      precipWindowMm,
      estimatedWaterLiters,
      riskIndex,
      riskColor,
      selectedForecastHour: safeForecastHour,
      selectedRainRateMmPerHour,
      windowStartHour: start,
      windowEndHour: safeForecastHour
    };
  }, [location, weather, radiusKm, safeHours, safeForecastHour, getRiskColor]);

  const hydroCounts = useMemo(
    () =>
      hydroData.features.reduce(
        (counts, feature) => {
          if (feature.geometry.type === "Polygon" || feature.geometry.type === "MultiPolygon") {
            counts.waterAreas += 1;
          } else {
            counts.waterways += 1;
          }
          return counts;
        },
        { waterways: 0, waterAreas: 0 }
      ),
    [hydroData]
  );

  const convertOverpassToGeoJSON = useCallback((response: OverpassResponse): HydroFeatureCollection => {
    const features: HydroFeature[] = [];

    response.elements.forEach((element) => {
      if (!element.geometry || element.geometry.length < 2) return;

      const coordinates = element.geometry.map((point) => [point.lon, point.lat] as [number, number]);
      const geometryType = element.tags?.waterway;

      const isClosedRing =
        coordinates[0]?.[0] === coordinates[coordinates.length - 1]?.[0] &&
        coordinates[0]?.[1] === coordinates[coordinates.length - 1]?.[1];

      const isAreaShape =
        isClosedRing &&
        (geometryType === "riverbank" ||
          element.tags?.natural === "water" ||
          element.tags?.area === "yes" ||
          Boolean(element.tags?.water));

      if (isAreaShape) {
        const polygonCoordinates = [coordinates];
        if (polygonCoordinates[0].length >= 4) {
          features.push({
            type: "Feature",
            geometry: {
              type: "Polygon",
              coordinates: polygonCoordinates
            },
            properties: {
              sourceId: element.id,
              waterway: element.tags?.waterway || "water",
              name: element.tags?.name || "Unnamed water feature",
              type: element.tags?.waterway || element.tags?.natural || "water"
            }
          });
        }
      } else {
        features.push({
          type: "Feature",
          geometry: {
            type: "LineString",
            coordinates
          },
          properties: {
            sourceId: element.id,
            waterway: element.tags?.waterway || "stream",
            name: element.tags?.name || "Unnamed stream",
            type: element.tags?.waterway || "stream"
          }
        });
      }
    });

    return {
      type: "FeatureCollection",
      features
    };
  }, []);

  const fetchHydrology = useCallback(
    async (lat: number, lng: number) => {
      const requestId = ++hydrologyRequestIdRef.current;
      setStatus("Loading nearby river/stream GIS layers...");
      setHydroError(null);
      setHydrologyStatus("loading");

      try {
        const meters = Math.max(2000, Math.round(radiusKm * 1000));
        const query = `
          [out:json][timeout:25];
          (
            way["waterway"~"river|stream|canal|drain|ditch|riverbank|ditch"](around:${meters},${lat},${lng});
            relation["waterway"~"river|stream|canal|drain|ditch|riverbank|ditch"](around:${meters},${lat},${lng});
            way["natural"="water"](around:${meters},${lat},${lng});
            relation["natural"="water"](around:${meters},${lat},${lng});
          );
          out geom;
        `;

        const body = new URLSearchParams({
          data: query.trim()
        });
        const response = await fetch("https://overpass-api.de/api/interpreter", {
          method: "POST",
          headers: {
            "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8"
          },
          body
        });

        if (!response.ok) {
          throw new Error(`Hydrology API returned ${response.status}`);
        }

        const payload = (await response.json()) as OverpassResponse;
        const collection = convertOverpassToGeoJSON(payload);
        if (requestId !== hydrologyRequestIdRef.current) return;

        setHydroData(collection);
        setHydrologyStatus("ready");
        setStatus("Nearby GIS layers loaded.");
      } catch (err) {
        if (requestId !== hydrologyRequestIdRef.current) return;

        setHydrologyStatus("error");
        setHydroError((err as Error).message || "Failed to load nearby GIS water layers.");
      }
    },
    [convertOverpassToGeoJSON, radiusKm]
  );

  const fetchWeather = useCallback(
    async (lat: number, lng: number, reason: WeatherSyncReason = "automatic") => {
      const requestId = ++weatherRequestIdRef.current;
      weatherLastRequestAtRef.current = Date.now();

      setIsWeatherRefreshing(true);
      setWeatherError(null);
      setStatus(reason === "initial" ? "Loading live weather data..." : "Synchronizing live weather data...");

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

        const hasValidHourlyRain =
          Array.isArray(payload.hourly?.time) &&
          Array.isArray(payload.hourly?.precipitation) &&
          payload.hourly.time.length > 0 &&
          payload.hourly.time.length === payload.hourly.precipitation.length &&
          payload.hourly.precipitation.every((value) => Number.isFinite(value) && value >= 0) &&
          Number.isFinite(payload.current?.precipitation) &&
          Number.isFinite(payload.current?.weather_code);

        if (!hasValidHourlyRain) {
          throw new Error("Weather service returned invalid precipitation data.");
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
        const updatedAt = Date.now();

        forecastHourRef.current = nextForecastHour;
        weatherRef.current = payload;
        lastWeatherUpdatedAtRef.current = updatedAt;
        setForecastHour(nextForecastHour);
        if (reason === "initial" || reason === "area") {
          setIsTimelinePlaying(false);
        }
        setWeather(payload);
        setLastWeatherUpdatedAt(updatedAt);
        setStatus(`Live weather synchronized at ${new Date(updatedAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit"
        })}.`);
      } catch (err) {
        if (requestId !== weatherRequestIdRef.current) return;

        const message = (err as Error).message || "Failed to refresh live weather data.";
        setWeatherError(message);
        setStatus(weatherRef.current ? "Live weather refresh delayed; showing the latest available data." : message);
      } finally {
        if (requestId === weatherRequestIdRef.current) {
          setIsWeatherRefreshing(false);
        }
      }
    },
    []
  );

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

      map.setTerrain({ source: "flood-terrain-dem", exaggeration: 1.45 });
      map.setFog({
        range: [0.6, 9],
        color: "#dce9e4",
        "high-color": "#8aa9b8",
        "space-color": "#08100e",
        "horizon-blend": 0.12
      });

      map.addSource("user-risk-zone", {
        type: "geojson",
        data: toFeatureCollection() as FeatureCollection
      });

      map.addLayer({
        id: "zone-fill",
        type: "fill",
        source: "user-risk-zone",
        slot: "middle",
        paint: {
          "fill-color": ["get", "riskColor"],
          "fill-opacity": 0.28
        }
      });

      map.addLayer({
        id: "zone-outline",
        type: "line",
        source: "user-risk-zone",
        slot: "middle",
        paint: {
          "line-color": ["get", "riskColor"],
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
    const riskSource = map.getSource("user-risk-zone") as mapboxgl.GeoJSONSource | undefined;
    const hydroSource = map.getSource("water-network") as mapboxgl.GeoJSONSource | undefined;
    const barangaySource = map.getSource("albay-barangays") as mapboxgl.GeoJSONSource | undefined;

    const sourceData: FeatureCollection<Polygon | Point> = {
      type: "FeatureCollection",
      features: [
        {
          ...analysis.polygon,
          properties: {
            radiusKm: analysis.radiusKm,
            riskIndex: analysis.riskIndex,
            riskColor: analysis.riskColor,
            waterLiters: analysis.estimatedWaterLiters
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

    if (riskSource) {
      riskSource.setData(sourceData);
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
          <div><strong>Flood risk:</strong> ${analysis.riskIndex}/100</div>
          <div class="popup-detail"><strong>Rain accumulation:</strong> ${formatNumber(
            analysis.precipWindowMm,
            1
          )} ${weather?.current_units.precipitation ?? "mm"}</div>
          <div class="popup-detail"><strong>Selected rain rate:</strong> ${formatNumber(analysis.selectedRainRateMmPerHour, 1)} mm/h</div>
          <div class="popup-detail"><strong>Window:</strong> ${formatTime(weather?.hourly.time[analysis.windowStartHour] ?? "")} → ${formatTime(
            weather?.hourly.time[analysis.windowEndHour] ?? ""
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

        const collection = (await response.json()) as BarangayFeatureCollection;
        if (collection.type !== "FeatureCollection" || !Array.isArray(collection.features)) {
          throw new Error("Barangay boundary file is invalid.");
        }

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
    const focusKey = selectedAreaKey;
    if (weatherFocusKeyRef.current === focusKey) return;

    const reason: WeatherSyncReason = weatherFocusKeyRef.current === null ? "initial" : "area";
    weatherFocusKeyRef.current = focusKey;
    setStatus(`Updating rainfall and GIS data for ${location.label}...`);
    void fetchWeather(location.lat, location.lng, reason);
  }, [fetchWeather, location, selectedAreaKey]);

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
    initializeMap(ALBAY_PROVINCE_FOCUS);
  }, [initializeMap]);

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
    const radiusRing = activeAnalysis?.polygon.geometry.coordinates[0];
    if (!map || !mapLoaded || !activeAnalysis || !radiusRing?.length) {
      context.clearRect(0, 0, canvas.width, canvas.height);
      return;
    }

    const rainMm = activeAnalysis.selectedRainRateMmPerHour;
    const measuredRainMm = Math.max(0, rainMm);
    const rainStrength = Math.min(1, measuredRainMm / 8);
    const baseFallSpeed = 90 + Math.min(measuredRainMm, 12) * 16;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let width = 0;
    let height = 0;
    let particles: RainParticle[] = [];
    let animationFrame = 0;
    let previousTime = performance.now();
    let rainClipPath: Path2D | null = null;

    const createParticle = (initial = false): RainParticle => ({
      x: Math.random() * width,
      y: initial ? Math.random() * height : -8 - Math.random() * 40,
      radius: 0.8 + rainStrength * 1.1 + Math.random() * 0.9,
      speed: baseFallSpeed * (0.82 + Math.random() * 0.36),
      drift: -7 + Math.random() * 14,
      opacity: 0.4 + Math.random() * 0.55
    });

    const updateRainClipPath = () => {
      const path = new Path2D();

      radiusRing.forEach((coordinate, index) => {
        const point = map.project(coordinate as [number, number]);
        if (index === 0) {
          path.moveTo(point.x, point.y);
        } else {
          path.lineTo(point.x, point.y);
        }
      });

      path.closePath();
      rainClipPath = path;
    };

    const drawParticles = () => {
      context.clearRect(0, 0, width, height);
      if (!rainClipPath) return;

      context.save();
      context.clip(rainClipPath);
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

      const areaScale = Math.max(0.55, Math.min(1.35, (width * height) / 620000));
      // The selected model rain rate directly controls particle density.
      // Randomness is used only to distribute those data-driven particles naturally.
      const count = measuredRainMm > 0 ? Math.min(180, Math.round(measuredRainMm * 40 * areaScale)) : 0;
      particles = Array.from({ length: count }, () => createParticle(true));
      drawParticles();
    };

    const resizeObserver = new ResizeObserver(resize);
    resizeObserver.observe(host);
    resize();

    const handleMapTransform = () => {
      updateRainClipPath();
      if (reduceMotion) drawParticles();
    };

    map.on("move", handleMapTransform);
    map.on("resize", handleMapTransform);

    if (!layerVisibility.rainAnimation || measuredRainMm <= 0 || reduceMotion) {
      if (!layerVisibility.rainAnimation || measuredRainMm <= 0) {
        context.clearRect(0, 0, width, height);
      }
      return () => {
        map.off("move", handleMapTransform);
        map.off("resize", handleMapTransform);
        resizeObserver.disconnect();
        context.clearRect(0, 0, width, height);
      };
    }

    const animateRain = (time: number) => {
      const elapsedSeconds = Math.min(0.04, (time - previousTime) / 1000);
      previousTime = time;

      particles.forEach((particle, index) => {
        particle.y += particle.speed * elapsedSeconds;
        particle.x += particle.drift * elapsedSeconds;

        if (particle.y > height + 8 || particle.x < -8 || particle.x > width + 8) {
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
      resizeObserver.disconnect();
      context.clearRect(0, 0, width, height);
    };
  }, [analysis, layerVisibility.rainAnimation, mapLoaded]);

  useEffect(() => {
    hydrologyRequestIdRef.current += 1;
    setHydrologyStatus("idle");
    setHydroData(toFeatureCollection());
    const handle = window.setTimeout(() => {
      fetchHydrology(location.lat, location.lng);
    }, 500);

    return () => window.clearTimeout(handle);
  }, [location, radiusKm, fetchHydrology]);

  useEffect(() => {
    if (!isTimelinePlaying || !hasWeather) return;

    if (safeForecastHour >= maxForecastHour) {
      setIsTimelinePlaying(false);
      return;
    }

    const handle = window.setTimeout(() => {
      setForecastHour((hour) => Math.min(hour + 1, maxForecastHour));
    }, 900);

    return () => window.clearTimeout(handle);
  }, [hasWeather, isTimelinePlaying, maxForecastHour, safeForecastHour]);

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
  const latestError = error || weatherError || hydroError || barangayError;
  const currentRainIntervalMinutes = Math.max(1, Math.round((weather?.current.interval ?? 3600) / 60));
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
            ? "Live model"
            : "Connecting";
  const nextSyncMinutes = lastWeatherUpdatedAt
    ? Math.max(0, Math.ceil((lastWeatherUpdatedAt + WEATHER_REFRESH_INTERVAL_MS - referenceNow) / 60_000))
    : null;

  const loadingStage = !weather
    ? 1
    : !mapLoaded
      ? 2
      : hydrologyStatus === "idle" ||
          hydrologyStatus === "loading" ||
          (barangayData.features.length === 0 && !barangayError)
        ? 3
        : 4;
  const loadingBlocked = Boolean((error || weatherError) && (!weather || !mapLoaded));
  const isInitialLoading = !hasFinishedInitialLoad && !loadingBlocked;
  const activeLoadingStage = INITIAL_LOADING_STEPS[loadingStage] ?? READY_LOADING_STAGE;
  const loadingProgress = [12, 38, 66, 90, 100][loadingStage];

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
        aria-label="Flood-risk dashboard"
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
                <p>Live flood intelligence</p>
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
                  <p>Search 18 cities and municipalities or 720 barangays.</p>
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

        <div className="district-forward-grid">
          <aside className="district-forward-sidebar" aria-label="Controls and snapshot metrics">
            <p className="district-forward-eyebrow">Hydrology workspace</p>
            <h2 className="district-forward-title">Flood conditions across Albay</h2>
            <p className="district-forward-lede">
              Search any Albay city, municipality, or barangay to analyze rainfall, nearby waterways, and estimated flood conditions.
            </p>

            <div className="district-forward-matrix">
              <div className="district-forward-cell">
                <strong>
                  {weather ? `${formatNumber(weather.current.precipitation)} ${weather.current_units.precipitation}` : "—"}
                </strong>
                <small>Current {currentRainIntervalMinutes}-min rain</small>
              </div>
              <div className="district-forward-cell">
                <strong>
                  {analysis ? `${formatNumber(analysis.selectedRainRateMmPerHour)} mm/h` : "—"}
                </strong>
                <small>Selected rain rate</small>
              </div>
              <div className="district-forward-cell">
                <strong
                  className="metric-value"
                  title={analysis ? `${formatNumber(analysis.estimatedWaterLiters, 0)} liters` : undefined}
                  aria-label={analysis ? `${formatNumber(analysis.estimatedWaterLiters, 0)} liters` : undefined}
                >
                  {analysis ? `${formatCompactNumber(analysis.estimatedWaterLiters)} L` : "—"}
                </strong>
                <small>Estimated water in zone</small>
              </div>
              <div className="district-forward-cell">
                <strong>
                  {analysis ? (
                    <span className="risk-badge" style={{ backgroundColor: analysis.riskColor }}>
                      {analysis.riskIndex}
                    </span>
                  ) : (
                    "—"
                  )}
                </strong>
                <small>Risk index (0-100)</small>
              </div>
              <div className="district-forward-cell">
                <strong
                  className="metric-value"
                  title={analysis ? `${formatNumber(analysis.radiusAreaKm2)} square kilometers` : undefined}
                  aria-label={analysis ? `${formatNumber(analysis.radiusAreaKm2)} square kilometers` : undefined}
                >
                  {analysis ? `${formatCompactNumber(analysis.radiusAreaKm2)} km²` : "—"}
                </strong>
                <small>Catchment area</small>
              </div>
              <div className="district-forward-cell">
                <strong>{weather ? getWeatherLabel(weather.current.weather_code) : "—"}</strong>
                <small>Weather summary</small>
              </div>
            </div>

            <div className="district-forward-controlblock">
              <h2>Simulation controls</h2>

              <div className="district-forward-area-picker">
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
                    aria-haspopup="dialog"
                    aria-expanded={isAreaPickerOpen}
                    aria-describedby="area-picker-description"
                    aria-busy={barangayData.features.length === 0 && !barangayError}
                  >
                    <span>{areaPickerLabel}</span>
                    <span className="area-search-icon" aria-hidden="true" />
                  </button>
                </div>
                <small id="area-picker-description" className="control-description">
                  Search province-wide and synchronize the model to the selected boundary.
                </small>
              </div>

              <div className="control-row">
                <label className="control-label" htmlFor="radius-km">
                  Analysis radius
                  <span className="value">{radiusKm} km</span>
                </label>
                <input
                  id="radius-km"
                  type="range"
                  min={0}
                  max={20}
                  value={radiusKm}
                  onChange={(event) => setRadiusKm(Number(event.target.value))}
                  aria-describedby="radius-description"
                />
                <small id="radius-description" className="control-description">
                  Start at the model focus point, then expand the circular catchment area.
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
                    <span>Live model rain dots</span>
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
                    <span>River and stream lines</span>
                    <strong>{hydroCounts.waterways}</strong>
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
                    <strong>{hydroCounts.waterAreas}</strong>
                  </label>
                </div>
              </fieldset>

            </div>
          </aside>

          <section className="district-forward-map" aria-label="Albay Province map view">
            <div
              ref={mapContainerRef}
              id="map"
              role="application"
              aria-label="Interactive 3D satellite map showing flood-risk analysis and water networks across Albay Province"
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
                <span>
                  <span className="district-forward-dot terrain" aria-hidden="true" />
                  3D satellite terrain
                </span>
                <span className={layerVisibility.rainZone ? "" : "is-hidden"}>
                  <span
                    className="district-forward-dot"
                    style={{ backgroundColor: analysis?.riskColor ?? "#94a3b8" }}
                    aria-hidden="true"
                  />
                  Rain accumulation / risk
                </span>
                <span className={layerVisibility.barangays ? "" : "is-hidden"}>
                  <span className="district-forward-dot barangay" aria-hidden="true" />
                  Barangay boundaries
                </span>
                <span className={layerVisibility.rainAnimation ? "" : "is-hidden"}>
                  <span className="district-forward-dot rain" aria-hidden="true" />
                  Live model rain dots
                </span>
                <span className={layerVisibility.waterways ? "" : "is-hidden"}>
                  <span
                    className="district-forward-dot"
                    style={{ backgroundColor: "#3a5c84" }}
                    aria-hidden="true"
                  />
                  Rivers and streams
                </span>
                <span className={layerVisibility.waterAreas ? "" : "is-hidden"}>
                  <span
                    className="district-forward-dot water-area"
                    aria-hidden="true"
                  />
                  Waterbody polygons
                </span>
                <span>
                  <span
                    className="district-forward-dot round"
                    style={{ backgroundColor: "#0d1112" }}
                    aria-hidden="true"
                  />
                  Model focus
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

          <aside className="district-forward-right" aria-label="Live readings">
            <h2>Readings</h2>

            <div className="district-forward-meta">
              <div className="district-forward-meta-row">
                <span>Accumulation window</span>
                <span>
                  {analysis && weather
                    ? `${formatTime(weather.hourly.time[analysis.windowStartHour])} → ${formatTime(
                        weather.hourly.time[analysis.windowEndHour]
                      )}`
                    : "—"}
                </span>
              </div>
              <div className="district-forward-meta-row">
                <span>Selected forecast rain</span>
                <span>
                  {analysis ? `${formatNumber(analysis.selectedRainRateMmPerHour)} mm/h` : "—"}
                </span>
              </div>
              <div className="district-forward-meta-row">
                <span>Window total</span>
                <span>{analysis ? `${formatNumber(analysis.precipWindowMm, 1)} mm` : "—"}</span>
              </div>
              <div className="district-forward-meta-row">
                <span>Weather feed</span>
                <span>Open-Meteo model • 5 min sync</span>
              </div>
              <div className="district-forward-meta-row">
                <span>Barangay GIS</span>
                <span>PSA / NAMRIA • {barangayData.features.length || 720} boundaries</span>
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
                <span>Coordinates</span>
                <span>{`${location.lat.toFixed(5)}, ${location.lng.toFixed(5)}`}</span>
              </div>
              <div className="district-forward-meta-row">
                <span>Elevation</span>
                <span>{weather ? `${formatNumber(weather.elevation, 0)} m` : "—"}</span>
              </div>
              <div className="district-forward-meta-row">
                <span>Latest error</span>
                <span>{latestError || "None"}</span>
              </div>
            </div>

            
          </aside>
        </div>
      </section>
    </main>
  );
}
