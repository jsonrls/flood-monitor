import type {
  Feature,
  FeatureCollection,
  LineString,
  MultiPolygon,
  Polygon,
  Position
} from "geojson";

export type OverpassPoint = {
  lat: number;
  lon: number;
};

export type OverpassMember = {
  type?: unknown;
  ref?: unknown;
  role?: unknown;
  geometry?: unknown;
};

export type OverpassElement = {
  type?: unknown;
  id?: unknown;
  geometry?: unknown;
  members?: unknown;
  tags?: unknown;
  timestamp?: unknown;
  version?: unknown;
};

export type OverpassPayload = {
  generator?: unknown;
  elements?: unknown;
  osm3s?: {
    timestamp_osm_base?: unknown;
    copyright?: unknown;
  };
};

export type HydrologyGeometry = LineString | Polygon | MultiPolygon;
export type HydrologyFeatureCollection = FeatureCollection<HydrologyGeometry>;

export type HydrologyCounts = {
  rivers: number;
  streams: number;
  canals: number;
  drains: number;
  ditches: number;
  tidalChannels: number;
  otherWaterways: number;
  waterbodies: number;
};

export const countHydrologyFeatures = (
  features: Array<Feature<HydrologyGeometry>>
): HydrologyCounts => {
  const counts: HydrologyCounts = {
    rivers: 0,
    streams: 0,
    canals: 0,
    drains: 0,
    ditches: 0,
    tidalChannels: 0,
    otherWaterways: 0,
    waterbodies: 0
  };

  features.forEach((feature) => {
    if (feature.properties?.featureClass === "waterbody") {
      counts.waterbodies += 1;
      return;
    }

    switch (feature.properties?.waterway) {
      case "river": counts.rivers += 1; break;
      case "stream": counts.streams += 1; break;
      case "canal": counts.canals += 1; break;
      case "drain": counts.drains += 1; break;
      case "ditch": counts.ditches += 1; break;
      case "tidal_channel": counts.tidalChannels += 1; break;
      default: counts.otherWaterways += 1;
    }
  });

  return counts;
};

const WATERWAY_TYPES = new Set(["river", "stream", "canal", "drain", "ditch", "tidal_channel"]);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const toTags = (value: unknown): Record<string, string> => {
  if (!isRecord(value)) return {};

  return Object.fromEntries(
    Object.entries(value).filter((entry): entry is [string, string] => typeof entry[1] === "string")
  );
};

const toCoordinate = (value: unknown): [number, number] | null => {
  if (!isRecord(value)) return null;

  const lat = value.lat;
  const lon = value.lon;
  return typeof lat === "number" &&
    Number.isFinite(lat) &&
    lat >= -90 &&
    lat <= 90 &&
    typeof lon === "number" &&
    Number.isFinite(lon) &&
    lon >= -180 &&
    lon <= 180
    ? [lon, lat]
    : null;
};

const toCoordinates = (value: unknown): Array<[number, number]> | null => {
  if (!Array.isArray(value) || value.length < 2) return null;

  const coordinates = value.map(toCoordinate);
  return coordinates.every((coordinate): coordinate is [number, number] => coordinate !== null)
    ? coordinates
    : null;
};

const coordinatesMatch = (a: Position | undefined, b: Position | undefined) =>
  Boolean(a && b && a[0] === b[0] && a[1] === b[1]);

const isClosedRing = (coordinates: Position[]) =>
  coordinates.length >= 4 && coordinatesMatch(coordinates[0], coordinates[coordinates.length - 1]);

const assembleRings = (segments: Position[][]) => {
  const unused = segments.filter((segment) => segment.length >= 2).map((segment) => [...segment]);
  const rings: Position[][] = [];

  while (unused.length > 0) {
    const ring = unused.shift()!;

    while (!isClosedRing(ring)) {
      const tail = ring[ring.length - 1];
      const matchingIndex = unused.findIndex(
        (segment) => coordinatesMatch(segment[0], tail) || coordinatesMatch(segment[segment.length - 1], tail)
      );

      if (matchingIndex === -1) break;

      const next = unused.splice(matchingIndex, 1)[0];
      if (coordinatesMatch(next[next.length - 1], tail)) next.reverse();
      ring.push(...next.slice(1));
    }

    if (isClosedRing(ring)) rings.push(ring);
  }

  return rings;
};

const pointInRing = (point: Position, ring: Position[]) => {
  let inside = false;

  for (let index = 0, previousIndex = ring.length - 1; index < ring.length; previousIndex = index++) {
    const current = ring[index];
    const previous = ring[previousIndex];
    const crossesRay =
      current[1] > point[1] !== previous[1] > point[1] &&
      point[0] <
        ((previous[0] - current[0]) * (point[1] - current[1])) /
          (previous[1] - current[1]) +
          current[0];

    if (crossesRay) inside = !inside;
  }

  return inside;
};

const isWaterbody = (tags: Record<string, string>) =>
  tags.natural === "water" ||
  tags.waterway === "riverbank" ||
  tags.landuse === "reservoir" ||
  tags.landuse === "basin";

export const normalizeOsmMapHydrology = (payloadValue: unknown): OverpassElement[] => {
  if (!isRecord(payloadValue) || !Array.isArray(payloadValue.elements)) {
    throw new Error("OpenStreetMap map API returned an invalid elements collection.");
  }

  const rawElements = payloadValue.elements.filter(isRecord);
  const nodes = new Map<number, { lat: number; lon: number }>();

  rawElements.forEach((element) => {
    if (
      element.type === "node" &&
      typeof element.id === "number" &&
      Number.isSafeInteger(element.id) &&
      typeof element.lat === "number" &&
      Number.isFinite(element.lat) &&
      typeof element.lon === "number" &&
      Number.isFinite(element.lon)
    ) {
      nodes.set(element.id, { lat: element.lat, lon: element.lon });
    }
  });

  const ways = new Map<number, OverpassElement>();
  rawElements.forEach((element) => {
    if (element.type !== "way" || typeof element.id !== "number" || !Number.isSafeInteger(element.id)) return;
    if (!Array.isArray(element.nodes)) return;

    const geometry = element.nodes
      .map((nodeId) => (typeof nodeId === "number" ? nodes.get(nodeId) ?? null : null))
      .filter((point): point is { lat: number; lon: number } => point !== null);
    if (geometry.length < 2) return;

    ways.set(element.id, { ...element, geometry });
  });

  const relations: OverpassElement[] = rawElements
    .filter((element) => element.type === "relation")
    .map((element) => {
      const members = Array.isArray(element.members)
        ? element.members.filter(isRecord).map((member) => {
            const memberWay =
              member.type === "way" && typeof member.ref === "number" ? ways.get(member.ref) : undefined;
            return {
              ...member,
              ...(memberWay?.geometry ? { geometry: memberWay.geometry } : {})
            };
          })
        : [];

      return { ...element, members };
    });

  return [...ways.values(), ...relations];
};

const featureProperties = (
  element: OverpassElement,
  tags: Record<string, string>,
  featureClass: "waterway" | "waterbody"
) => {
  const sourceType = element.type as "way" | "relation";
  const sourceId = element.id as number;
  const sourceTimestamp =
    typeof element.timestamp === "string" && Number.isFinite(new Date(element.timestamp).valueOf())
      ? element.timestamp
      : null;

  return {
    sourceId,
    sourceType,
    sourceUrl: `https://www.openstreetmap.org/${sourceType}/${sourceId}`,
    sourceVersion:
      typeof element.version === "number" && Number.isSafeInteger(element.version) && element.version > 0
        ? element.version
        : null,
    sourceLastEditedAt: sourceTimestamp,
    featureClass,
    waterway: tags.waterway ?? null,
    waterbody: tags.water ?? tags.natural ?? tags.landuse ?? null,
    intermittent: tags.intermittent === "yes",
    name: tags.name || (featureClass === "waterbody" ? "Unnamed waterbody" : "Unnamed waterway"),
    type: tags.waterway || tags.water || tags.natural || tags.landuse || featureClass
  };
};

const convertRelation = (element: OverpassElement): Feature<Polygon | MultiPolygon> | null => {
  const tags = toTags(element.tags);
  if (element.type !== "relation" || !Number.isSafeInteger(element.id) || !isWaterbody(tags)) return null;
  if (!Array.isArray(element.members)) return null;

  const members = element.members.filter(isRecord) as Array<Record<string, unknown>>;
  const outerSegments = members
    .filter((member) => member.type === "way" && (member.role === "outer" || member.role === ""))
    .map((member) => toCoordinates(member.geometry))
    .filter((geometry): geometry is Array<[number, number]> => geometry !== null);
  const innerSegments = members
    .filter((member) => member.type === "way" && member.role === "inner")
    .map((member) => toCoordinates(member.geometry))
    .filter((geometry): geometry is Array<[number, number]> => geometry !== null);
  const outerRings = assembleRings(outerSegments);
  const innerRings = assembleRings(innerSegments);

  if (outerRings.length === 0) return null;

  const polygons: Position[][][] = outerRings.map((ring) => [ring]);
  innerRings.forEach((innerRing) => {
    const containingPolygon = outerRings.findIndex((outerRing) => pointInRing(innerRing[0], outerRing));
    if (containingPolygon >= 0) polygons[containingPolygon].push(innerRing);
  });

  return {
    type: "Feature",
    geometry:
      polygons.length === 1
        ? { type: "Polygon", coordinates: polygons[0] }
        : { type: "MultiPolygon", coordinates: polygons },
    properties: featureProperties(element, tags, "waterbody")
  };
};

export const convertOverpassToHydrology = (elementsValue: unknown) => {
  if (!Array.isArray(elementsValue)) {
    throw new Error("Overpass returned an invalid elements collection.");
  }

  const elements = elementsValue.filter(isRecord) as OverpassElement[];
  const features: Array<Feature<HydrologyGeometry>> = [];
  const relationMemberWayIds = new Set<number>();

  elements.forEach((element) => {
    const relationFeature = convertRelation(element);
    if (!relationFeature) return;

    features.push(relationFeature);
    if (Array.isArray(element.members)) {
      element.members.filter(isRecord).forEach((member) => {
        if (member.type === "way" && typeof member.ref === "number" && Number.isSafeInteger(member.ref)) {
          relationMemberWayIds.add(member.ref);
        }
      });
    }
  });

  elements.forEach((element) => {
    if (element.type !== "way" || !Number.isSafeInteger(element.id)) return;
    if (relationMemberWayIds.has(element.id as number)) return;

    const tags = toTags(element.tags);
    const coordinates = toCoordinates(element.geometry);
    if (!coordinates) return;

    if (isWaterbody(tags)) {
      if (!isClosedRing(coordinates)) return;
      features.push({
        type: "Feature",
        geometry: { type: "Polygon", coordinates: [coordinates] },
        properties: featureProperties(element, tags, "waterbody")
      });
      return;
    }

    if (!tags.waterway || !WATERWAY_TYPES.has(tags.waterway)) return;
    features.push({
      type: "Feature",
      geometry: { type: "LineString", coordinates },
      properties: featureProperties(element, tags, "waterway")
    });
  });

  const counts = countHydrologyFeatures(features);

  const data: HydrologyFeatureCollection = {
    type: "FeatureCollection",
    features
  };

  return { data, counts };
};
