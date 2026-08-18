import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { DATA_SOURCES } from "@/lib/dataSources";
import * as turf from "@turf/turf";
import type { Feature, FeatureCollection, MultiPolygon, Polygon } from "geojson";
import {
  countHydrologyFeatures,
  convertOverpassToHydrology,
  type OverpassPayload
} from "@/lib/osmHydrology";

export const runtime = "nodejs";

const HYDROLOGY_CACHE_SECONDS = 10 * 60;
const MAX_OVERPASS_LAG_MS = 6 * 60 * 60 * 1000;
const MAX_SOURCE_CLOCK_SKEW_MS = 5 * 60 * 1000;
const ALBAY_PROVINCE_CODE = "05005";
const VERIFIED_ALBAY_BARANGAY_COUNT = 720;

type HydrologyScope = "province" | "municipality" | "barangay";

type BoundaryProperties = {
  code: string;
  name: string;
  areaSqKm: number;
  municipalityCode: string;
  municipalityName: string;
  provinceCode: string;
  provinceName: string;
};

type BoundaryMetadata = {
  province: string;
  provinceCode: string;
  snapshot: string;
  boundarySource: string;
  codeSource: string;
  featureCount: number;
};

type BoundaryCollection = FeatureCollection<Polygon | MultiPolygon, BoundaryProperties> & {
  metadata: BoundaryMetadata;
};

type SelectedArea = {
  scope: HydrologyScope;
  code: string;
  name: string;
  boundary: Feature<Polygon | MultiPolygon>;
  boundaryParts: Array<{
    feature: Feature<Polygon>;
    bounds: [number, number, number, number];
  }>;
  metadata: BoundaryMetadata;
};

type UpstreamResult = {
  payload: OverpassPayload;
  endpoint: string;
  datasetUpdatedAt: string;
  snapshotAgeSeconds: number;
};

let boundaryCollectionPromise: Promise<BoundaryCollection> | null = null;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isValidTimestamp = (value: unknown, allowOld = true) => {
  if (typeof value !== "string") return false;
  const timestamp = new Date(value).valueOf();
  if (!Number.isFinite(timestamp) || timestamp > Date.now() + MAX_SOURCE_CLOCK_SKEW_MS) return false;
  return allowOld || Date.now() - timestamp <= MAX_OVERPASS_LAG_MS;
};

const isValidCoordinate = (value: unknown) =>
  isRecord(value) &&
  typeof value.lat === "number" &&
  Number.isFinite(value.lat) &&
  value.lat >= -90 &&
  value.lat <= 90 &&
  typeof value.lon === "number" &&
  Number.isFinite(value.lon) &&
  value.lon >= -180 &&
  value.lon <= 180;

const hasValidSourceIdentity = (element: unknown) =>
  isRecord(element) &&
  (element.type === "way" || element.type === "relation") &&
  typeof element.id === "number" &&
  Number.isSafeInteger(element.id) &&
  element.id > 0 &&
  typeof element.version === "number" &&
  Number.isSafeInteger(element.version) &&
  element.version > 0 &&
  isValidTimestamp(element.timestamp);

const validateOverpassElement = (element: unknown) => {
  if (!hasValidSourceIdentity(element) || !isRecord(element) || !isRecord(element.tags)) return false;

  if (element.type === "way") {
    return Array.isArray(element.geometry) &&
      element.geometry.length >= 2 &&
      element.geometry.every(isValidCoordinate);
  }

  if (!Array.isArray(element.members)) return false;
  return element.members.every((member) => {
    if (!isRecord(member) || typeof member.type !== "string" || typeof member.ref !== "number") return false;
    if (member.type !== "way" || (member.role !== "outer" && member.role !== "inner" && member.role !== "")) {
      return true;
    }
    return Array.isArray(member.geometry) &&
      member.geometry.length >= 2 &&
      member.geometry.every(isValidCoordinate);
  });
};

const validateOverpassPayload = (payloadValue: unknown) => {
  if (!isRecord(payloadValue) || typeof payloadValue.generator !== "string") {
    throw new Error("missing Overpass generator metadata");
  }
  if (!payloadValue.generator.startsWith("Overpass API ") || !isRecord(payloadValue.osm3s)) {
    throw new Error("unrecognized Overpass source identity");
  }

  const copyright = payloadValue.osm3s.copyright;
  const datasetUpdatedAt = payloadValue.osm3s.timestamp_osm_base;
  if (
    typeof copyright !== "string" ||
    !copyright.includes("openstreetmap.org") ||
    !copyright.includes("ODbL")
  ) {
    throw new Error("invalid OpenStreetMap attribution metadata");
  }
  if (!isValidTimestamp(datasetUpdatedAt, false)) {
    throw new Error("stale or invalid OpenStreetMap snapshot timestamp");
  }
  if (!Array.isArray(payloadValue.elements) || !payloadValue.elements.every(validateOverpassElement)) {
    throw new Error("invalid Overpass element metadata or geometry");
  }

  const snapshotTime = new Date(datasetUpdatedAt as string).valueOf();
  return {
    payload: payloadValue as OverpassPayload,
    datasetUpdatedAt: datasetUpdatedAt as string,
    snapshotAgeSeconds: Math.max(0, Math.round((Date.now() - snapshotTime) / 1000))
  };
};

const validateBoundaryCollection = (value: unknown): BoundaryCollection => {
  if (!isRecord(value) || value.type !== "FeatureCollection" || !Array.isArray(value.features)) {
    throw new Error("The bundled Albay boundary dataset is invalid.");
  }
  if (!isRecord(value.metadata)) {
    throw new Error("The bundled Albay boundary metadata is missing.");
  }

  const metadata = value.metadata;
  if (
    metadata.province !== "Albay" ||
    metadata.provinceCode !== ALBAY_PROVINCE_CODE ||
    typeof metadata.snapshot !== "string" ||
    metadata.boundarySource !== "NAMRIA" ||
    typeof metadata.codeSource !== "string" ||
    metadata.featureCount !== VERIFIED_ALBAY_BARANGAY_COUNT ||
    value.features.length !== VERIFIED_ALBAY_BARANGAY_COUNT
  ) {
    throw new Error("The bundled Albay boundary coverage or provenance is invalid.");
  }

  const featuresAreValid = value.features.every((candidate) => {
    if (!isRecord(candidate) || candidate.type !== "Feature" || !isRecord(candidate.properties)) return false;
    if (!isRecord(candidate.geometry)) return false;
    const properties = candidate.properties;
    return (
      (candidate.geometry.type === "Polygon" || candidate.geometry.type === "MultiPolygon") &&
      Array.isArray(candidate.geometry.coordinates) &&
      typeof properties.code === "string" &&
      /^05005\d{5}$/.test(properties.code) &&
      typeof properties.municipalityCode === "string" &&
      /^05005\d{2}000$/.test(properties.municipalityCode) &&
      properties.provinceCode === ALBAY_PROVINCE_CODE &&
      typeof properties.name === "string" &&
      typeof properties.municipalityName === "string" &&
      typeof properties.areaSqKm === "number" &&
      Number.isFinite(properties.areaSqKm) &&
      properties.areaSqKm > 0
    );
  });
  if (!featuresAreValid) {
    throw new Error("The bundled Albay boundary features failed validation.");
  }

  return value as unknown as BoundaryCollection;
};

const loadBoundaryCollection = () => {
  boundaryCollectionPromise ??= readFile(join(process.cwd(), "public", "albay-barangays.geojson"), "utf8")
    .then((contents) => validateBoundaryCollection(JSON.parse(contents)))
    .catch((error) => {
      boundaryCollectionPromise = null;
      throw error;
    });
  return boundaryCollectionPromise;
};

const combineBoundaries = (
  features: Array<Feature<Polygon | MultiPolygon, BoundaryProperties>>
): Feature<Polygon | MultiPolygon> => {
  if (features.length === 1) return features[0];

  const flattened = turf.flatten(
    turf.featureCollection(features)
  ) as FeatureCollection<Polygon, BoundaryProperties>;
  const dissolved = turf.dissolve(flattened);
  if (dissolved.features.length === 1) return dissolved.features[0];

  const polygons: MultiPolygon["coordinates"] = [];
  dissolved.features.forEach((feature) => {
    polygons.push(feature.geometry.coordinates);
  });
  return turf.multiPolygon(polygons);
};

const prepareBoundaryParts = (boundary: Feature<Polygon | MultiPolygon>) =>
  (turf.flatten(boundary) as FeatureCollection<Polygon>).features.map((feature) => ({
    feature,
    bounds: turf.bbox(feature) as [number, number, number, number]
  }));

const intersectsBoundaryParts = (
  feature: Feature,
  boundaryParts: SelectedArea["boundaryParts"]
) => {
  const [featureWest, featureSouth, featureEast, featureNorth] = turf.bbox(feature);
  return boundaryParts.some(({ feature: boundaryPart, bounds: [west, south, east, north] }) => {
    if (featureEast < west || featureWest > east || featureNorth < south || featureSouth > north) return false;
    return turf.booleanIntersects(feature, boundaryPart);
  });
};

const resolveSelectedArea = async (scopeValue: string | null, codeValue: string | null): Promise<SelectedArea> => {
  if (scopeValue !== "province" && scopeValue !== "municipality" && scopeValue !== "barangay") {
    throw new Error("scope must be province, municipality, or barangay.");
  }

  const boundaries = await loadBoundaryCollection();
  const scope = scopeValue as HydrologyScope;
  const code = codeValue?.trim() ?? "";
  let features: Array<Feature<Polygon | MultiPolygon, BoundaryProperties>>;
  let name: string;

  if (scope === "province") {
    if (code !== ALBAY_PROVINCE_CODE) throw new Error("The province code must be 05005 for Albay.");
    features = boundaries.features;
    name = "Albay Province";
  } else if (scope === "municipality") {
    if (!/^05005\d{2}000$/.test(code)) throw new Error("A valid Albay municipality code is required.");
    features = boundaries.features.filter((feature) => feature.properties.municipalityCode === code);
    if (features.length === 0) throw new Error("The selected municipality is not in the validated Albay dataset.");
    name = `${features[0].properties.municipalityName}, Albay`;
  } else {
    if (!/^05005\d{5}$/.test(code)) throw new Error("A valid Albay barangay code is required.");
    features = boundaries.features.filter((feature) => feature.properties.code === code);
    if (features.length !== 1) throw new Error("The selected barangay is not in the validated Albay dataset.");
    name = `${features[0].properties.name}, ${features[0].properties.municipalityName}`;
  }

  const boundary = combineBoundaries(features);
  return {
    scope,
    code,
    name,
    boundary,
    boundaryParts: prepareBoundaryParts(boundary),
    metadata: boundaries.metadata
  };
};

const fetchOverpassEndpoint = async (
  query: string,
  endpoint: string,
  controller: AbortController,
  timeoutMs: number
): Promise<UpstreamResult> => {
  const timeout = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(endpoint, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Content-Type": "application/x-www-form-urlencoded;charset=UTF-8",
        "User-Agent": "Albay-Flood-Monitor/0.1"
      },
      body: new URLSearchParams({ data: query }),
      cache: "no-store",
      signal: controller.signal
    });

    if (!response.ok) throw new Error(`${response.status}`);
    const contentType = response.headers.get("content-type") ?? "";
    if (!contentType.includes("json")) throw new Error("non-JSON response");

    const validated = validateOverpassPayload(await response.json());
    return { ...validated, endpoint };
  } finally {
    clearTimeout(timeout);
  }
};

const fetchOverpass = async (query: string, endpoints: string[], timeoutMs: number): Promise<UpstreamResult> => {
  if (endpoints.length === 0) throw new Error("No Overpass providers configured.");
  const controllers = endpoints.map(() => new AbortController());
  const started = endpoints.map(() => false);
  const timers: Array<ReturnType<typeof setTimeout>> = [];
  const failures: string[] = [];

  return new Promise<UpstreamResult>((resolve, reject) => {
    let completed = 0;
    let settled = false;

    const startEndpoint = (index: number) => {
      if (settled || started[index]) return;
      started[index] = true;
      const endpoint = endpoints[index];

      fetchOverpassEndpoint(query, endpoint, controllers[index], timeoutMs)
        .then((result) => {
          if (settled) return;
          settled = true;
          timers.forEach(clearTimeout);
          controllers.forEach((controller, controllerIndex) => {
            if (controllerIndex !== index) controller.abort();
          });
          resolve(result);
        })
        .catch((error) => {
          if (settled) return;
          failures.push(`${new URL(endpoint).hostname}: ${(error as Error).message || "request failed"}`);
          completed += 1;

          // If the preferred provider fails before the stagger elapses, do not
          // make the user wait before trying the documented alternatives.
          if (index === 0) {
            timers.forEach(clearTimeout);
            endpoints.slice(1).forEach((_, fallbackIndex) => startEndpoint(fallbackIndex + 1));
          }

          if (completed === endpoints.length) {
            settled = true;
            reject(new Error(`Overpass providers unavailable (${failures.join(", ")}).`));
          }
        });
    };

    startEndpoint(0);
    endpoints.slice(1).forEach((_, fallbackIndex) => {
      timers.push(setTimeout(() => startEndpoint(fallbackIndex + 1), 2_500));
    });
  });
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);

  let selectedArea: SelectedArea;
  try {
    selectedArea = await resolveSelectedArea(searchParams.get("scope"), searchParams.get("code"));
  } catch (error) {
    return Response.json({ error: (error as Error).message }, { status: 400 });
  }

  const [west, south, east, north] = turf.bbox(selectedArea.boundary);
  const queryBounds = { south, west, north, east };
  const bbox = `${south.toFixed(6)},${west.toFixed(6)},${north.toFixed(6)},${east.toFixed(6)}`;
  const upstreamQueryTimeoutSeconds = selectedArea.scope === "province" ? 45 : selectedArea.scope === "municipality" ? 30 : 20;
  const requestTimeoutMs = (upstreamQueryTimeoutSeconds + 5) * 1000;
  const hydrologyQuery = `[out:json][timeout:${upstreamQueryTimeoutSeconds}][bbox:${bbox}];(
    way["waterway"~"^(river|stream|canal|drain|ditch|tidal_channel)$"];
    way["natural"="water"];
    way["landuse"~"^(reservoir|basin)$"];
    way["waterway"="riverbank"];
    relation["natural"="water"];
    relation["landuse"~"^(reservoir|basin)$"];
    relation["waterway"="riverbank"];
  );out geom meta;`;

  try {
    const hydrologyResult = await fetchOverpass(
      hydrologyQuery,
      [...DATA_SOURCES.hydrology.overpassEndpoints],
      requestTimeoutMs
    );
    const converted = convertOverpassToHydrology(hydrologyResult.payload.elements);
    const data = {
      ...converted.data,
      features: converted.data.features.filter((feature) => {
        try {
          return intersectsBoundaryParts(feature, selectedArea.boundaryParts);
        } catch {
          return false;
        }
      })
    };
    const counts = countHydrologyFeatures(data.features);
    const servedAt = new Date().toISOString();

    return Response.json(
      {
        data,
        counts,
        _provenance: {
          provider: "OpenStreetMap",
          copyright_url: DATA_SOURCES.hydrology.copyrightUrl,
          served_at: servedAt,
          dataset_updated_at: hydrologyResult.datasetUpdatedAt,
          selected_area: {
            scope: selectedArea.scope,
            code: selectedArea.code,
            name: selectedArea.name,
            boundary_source: selectedArea.metadata.boundarySource,
            boundary_snapshot: DATA_SOURCES.administrativeGeometry.snapshot,
            code_source: selectedArea.metadata.codeSource,
            code_snapshot: selectedArea.metadata.snapshot
          },
          query_bounds: queryBounds,
          selection_method: "administrative-boundary-intersection",
          upstream_hosts: [new URL(hydrologyResult.endpoint).hostname],
          retrieval_mode: "overpass",
          source_validation: {
            schema: "passed",
            attribution: "passed",
            geometry: "passed",
            freshness: "fresh-overpass-snapshot",
            snapshot_age_seconds: hydrologyResult.snapshotAgeSeconds,
            maximum_snapshot_age_seconds: MAX_OVERPASS_LAG_MS / 1000
          },
          waterway_lines: "included",
          way_waterbodies: "included",
          relation_waterbodies: "included"
        }
      },
      {
        headers: {
          "Cache-Control": `public, max-age=${HYDROLOGY_CACHE_SECONDS}, s-maxage=${HYDROLOGY_CACHE_SECONDS}, stale-while-revalidate=60`,
          "X-Hydrology-Source": "OpenStreetMap",
          "X-Data-Provenance": "Validated current OSM features intersecting a validated Albay administrative boundary",
          "X-Hydrology-Scope": `${selectedArea.scope}:${selectedArea.code}`,
          "X-Hydrology-Freshness": "fresh-overpass-snapshot"
        }
      }
    );
  } catch (error) {
    return Response.json(
      { error: (error as Error).message || "Hydrology providers are temporarily unavailable." },
      { status: 502 }
    );
  }
}
