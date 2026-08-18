import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { area } from "@turf/turf";

const DATASET_PATH = new URL("../public/albay-barangays.geojson", import.meta.url);
const LEGACY_LEGAZPI_PATH = new URL("../public/legazpi-barangays.geojson", import.meta.url);
const EXPECTED_SHA256 = "153658c2894ec4bfcb42ac9ca0de60e94520ef6b2980fda4bb596b72124e41ad";
const EXPECTED_LEGAZPI_SHA256 = "60b105a72f77ce543a2f04c81d79837594464e4a54d30b84af46be336e8df593";
const EXPECTED = {
  province: "Albay",
  provinceCode: "05005",
  psgcSnapshot: "2023-10-24",
  boundarySource: "NAMRIA",
  barangays: 720,
  localGovernmentUnits: 18,
  cities: 3,
  municipalities: 15
};

const fail = (message) => {
  throw new Error(`Data validation failed: ${message}`);
};

const raw = await readFile(DATASET_PATH);
const sha256 = createHash("sha256").update(raw).digest("hex");
if (sha256 !== EXPECTED_SHA256) {
  fail(`unexpected boundary-file SHA-256 ${sha256}`);
}

const dataset = JSON.parse(raw.toString("utf8"));
const metadata = dataset.metadata;
if (
  dataset.type !== "FeatureCollection" ||
  !Array.isArray(dataset.features) ||
  metadata?.province !== EXPECTED.province ||
  metadata?.provinceCode !== EXPECTED.provinceCode ||
  metadata?.snapshot !== EXPECTED.psgcSnapshot ||
  metadata?.boundarySource !== EXPECTED.boundarySource ||
  metadata?.codeSource !== "Philippine Statistics Authority PSGC" ||
  metadata?.featureCount !== EXPECTED.barangays ||
  dataset.features.length !== EXPECTED.barangays
) {
  fail("collection metadata or feature count does not match the documented source release");
}

const barangayCodes = new Set();
const municipalityNames = new Map();
let calculatedAreaSqKm = 0;

dataset.features.forEach((feature, index) => {
  const properties = feature?.properties;
  const geometry = feature?.geometry;
  const label = `feature ${index + 1}`;

  if (
    feature?.type !== "Feature" ||
    !properties ||
    !geometry ||
    !["Polygon", "MultiPolygon"].includes(geometry.type) ||
    !/^\d{10}$/.test(properties.code) ||
    !/^\d{10}$/.test(properties.municipalityCode) ||
    properties.provinceCode !== EXPECTED.provinceCode ||
    properties.provinceName !== EXPECTED.province ||
    typeof properties.name !== "string" ||
    properties.name.trim() === "" ||
    typeof properties.municipalityName !== "string" ||
    properties.municipalityName.trim() === ""
  ) {
    fail(`${label} has incomplete PSGC properties or invalid geometry`);
  }

  if (barangayCodes.has(properties.code)) {
    fail(`duplicate barangay PSGC code ${properties.code}`);
  }

  const featureAreaSqKm = area(feature) / 1_000_000;
  if (!Number.isFinite(featureAreaSqKm) || featureAreaSqKm <= 0) {
    fail(`${label} has a non-positive calculated geodesic area`);
  }

  barangayCodes.add(properties.code);
  municipalityNames.set(properties.municipalityCode, properties.municipalityName);
  calculatedAreaSqKm += featureAreaSqKm;
});

const cityCount = [...municipalityNames.values()].filter(
  (name) => name.startsWith("City of ") || name.includes(" City ")
).length;
const municipalityCount = municipalityNames.size - cityCount;

if (
  municipalityNames.size !== EXPECTED.localGovernmentUnits ||
  cityCount !== EXPECTED.cities ||
  municipalityCount !== EXPECTED.municipalities
) {
  fail(
    `expected ${EXPECTED.cities} cities and ${EXPECTED.municipalities} municipalities; found ${cityCount} and ${municipalityCount}`
  );
}

const legacyLegazpiRaw = await readFile(LEGACY_LEGAZPI_PATH);
const legacyLegazpiSha256 = createHash("sha256").update(legacyLegazpiRaw).digest("hex");
if (legacyLegazpiSha256 !== EXPECTED_LEGAZPI_SHA256) {
  fail(`unexpected legacy Legazpi boundary-file SHA-256 ${legacyLegazpiSha256}`);
}

const legacyLegazpi = JSON.parse(legacyLegazpiRaw.toString("utf8"));
const canonicalLegazpi = dataset.features.filter(
  (feature) => feature.properties.municipalityCode === "0500506000"
);
const canonicalLegazpiByCode = new Map(
  canonicalLegazpi.map((feature) => [feature.properties.code, feature])
);

if (
  legacyLegazpi.type !== "FeatureCollection" ||
  !Array.isArray(legacyLegazpi.features) ||
  legacyLegazpi.features.length !== canonicalLegazpi.length ||
  legacyLegazpi.features.some((feature) => {
    const canonical = canonicalLegazpiByCode.get(feature.properties?.code);
    return (
      !canonical ||
      canonical.properties.name !== feature.properties?.name ||
      canonical.properties.areaSqKm !== feature.properties?.areaSqKm ||
      JSON.stringify(canonical.geometry) !== JSON.stringify(feature.geometry)
    );
  })
) {
  fail("legacy Legazpi extract is not an exact 70-feature subset of the validated province dataset");
}

console.log("Validated source-backed Albay boundary dataset");
console.log(`  SHA-256: ${sha256}`);
console.log(`  Coverage: ${barangayCodes.size} barangays across ${municipalityNames.size} LGUs`);
console.log(`  Calculated displayed geometry area: ${calculatedAreaSqKm.toFixed(2)} km²`);
console.log("  Names/codes: Philippine Statistics Authority PSGC snapshot 2023-10-24");
console.log("  Geometry: NAMRIA-derived boundary snapshot 2023-11-06, release v2026.4.13.0");
console.log("  Current coverage cross-check: PSA PSGC as of 2026-06-30");
console.log(`  Legacy Legazpi extract: ${legacyLegazpi.features.length} exact matching features (${legacyLegazpiSha256})`);
