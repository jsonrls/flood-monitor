import type { Metadata } from "next";
import Link from "next/link";
import Image from "next/image";
import { DATA_SOURCES, VERIFIED_ALBAY_COVERAGE } from "@/lib/dataSources";

export const metadata: Metadata = {
  title: "Data Sources",
  description:
    "Every dataset behind the Albay Flood Monitor: weather models, PAGASA rain gauges, administrative boundaries, and basemap imagery.",
  alternates: {
    canonical: "/data-sources"
  }
};

const numberFormatter = new Intl.NumberFormat("en-PH");

export default function DataSourcesPage() {
  return (
    <main className="data-sources-page">
      <div className="data-sources-shell">
        <header className="data-sources-header">
          <div className="district-forward-brand-wrap">
            <p className="district-forward-brand">
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
            </p>
            <small>Service Landings • GIS Flood Intelligence</small>
          </div>
          <Link href="/" className="data-sources-back">
            ← Back to map
          </Link>
        </header>

        <div className="data-sources-body">
          <h1>Data sources</h1>
          <p className="data-sources-lede">
            Everything on the map is traceable to the publishers below. The monitor shows model output and
            volunteered geographic data — it carries no official flood warning data. For official advisories,
            always consult{" "}
            <a href={DATA_SOURCES.officialGuidance.url} target="_blank" rel="noreferrer">
              {DATA_SOURCES.officialGuidance.name}
            </a>
            .
          </p>

          <section className="data-source-card" aria-labelledby="source-weather">
            <h2 id="source-weather">{DATA_SOURCES.weather.name}</h2>
            <p>{DATA_SOURCES.weather.description}. Drives the model rainfall, temperature, wind, and humidity readings.</p>
            <dl>
              <div>
                <dt>Documentation</dt>
                <dd>
                  <a href={DATA_SOURCES.weather.documentationUrl} target="_blank" rel="noreferrer">
                    {DATA_SOURCES.weather.documentationUrl}
                  </a>
                </dd>
              </div>
              <div>
                <dt>Endpoint</dt>
                <dd>
                  <code>{DATA_SOURCES.weather.endpoint}</code>
                </dd>
              </div>
            </dl>
          </section>

          <section className="data-source-card" aria-labelledby="source-rainfall">
            <h2 id="source-rainfall">{DATA_SOURCES.officialRainfall.name}</h2>
            <p>{DATA_SOURCES.officialRainfall.description}. Shown as the official PAGASA rain-gauge observation.</p>
            <dl>
              <div>
                <dt>Published at</dt>
                <dd>
                  <a href={DATA_SOURCES.officialRainfall.endpoint} target="_blank" rel="noreferrer">
                    {DATA_SOURCES.officialRainfall.endpoint}
                  </a>
                </dd>
              </div>
            </dl>
          </section>

          <section className="data-source-card" aria-labelledby="source-psgc">
            <h2 id="source-psgc">{DATA_SOURCES.administrativeNames.name}</h2>
            <p>Official names and codes for Albay&apos;s cities, municipalities, and barangays.</p>
            <dl>
              <div>
                <dt>Snapshot</dt>
                <dd>{DATA_SOURCES.administrativeNames.snapshot}</dd>
              </div>
              <div>
                <dt>Coverage re-verified</dt>
                <dd>{DATA_SOURCES.administrativeNames.currentCoverageReference}</dd>
              </div>
              <div>
                <dt>Reference</dt>
                <dd>
                  <a href={DATA_SOURCES.administrativeNames.url} target="_blank" rel="noreferrer">
                    {DATA_SOURCES.administrativeNames.url}
                  </a>
                </dd>
              </div>
            </dl>
          </section>

          <section className="data-source-card" aria-labelledby="source-boundaries">
            <h2 id="source-boundaries">{DATA_SOURCES.administrativeGeometry.name}</h2>
            <p>Boundary polygons used to scope rainfall coverage to the selected area.</p>
            <dl>
              <div>
                <dt>Snapshot</dt>
                <dd>{DATA_SOURCES.administrativeGeometry.snapshot}</dd>
              </div>
              <div>
                <dt>Release</dt>
                <dd>{DATA_SOURCES.administrativeGeometry.release}</dd>
              </div>
              <div>
                <dt>Reference</dt>
                <dd>
                  <a href={DATA_SOURCES.administrativeGeometry.url} target="_blank" rel="noreferrer">
                    {DATA_SOURCES.administrativeGeometry.url}
                  </a>
                </dd>
              </div>
            </dl>
          </section>

          <section className="data-source-card" aria-labelledby="source-basemap">
            <h2 id="source-basemap">{DATA_SOURCES.basemap.name}</h2>
            <p>Satellite imagery, 3D terrain elevation, and place labels behind every layer.</p>
            <dl>
              <div>
                <dt>Documentation</dt>
                <dd>
                  <a href={DATA_SOURCES.basemap.documentationUrl} target="_blank" rel="noreferrer">
                    {DATA_SOURCES.basemap.documentationUrl}
                  </a>
                </dd>
              </div>
            </dl>
          </section>

          <section className="data-source-card" aria-labelledby="source-coverage">
            <h2 id="source-coverage">Verified Albay coverage</h2>
            <p>
              Administrative names and boundaries were cross-checked against the PSGC listing as of{" "}
              {VERIFIED_ALBAY_COVERAGE.verifiedAsOf}.
            </p>
            <dl>
              <div>
                <dt>Barangays</dt>
                <dd>{numberFormatter.format(VERIFIED_ALBAY_COVERAGE.barangays)}</dd>
              </div>
              <div>
                <dt>Municipalities</dt>
                <dd>{numberFormatter.format(VERIFIED_ALBAY_COVERAGE.municipalities)}</dd>
              </div>
              <div>
                <dt>Cities</dt>
                <dd>{numberFormatter.format(VERIFIED_ALBAY_COVERAGE.cities)}</dd>
              </div>
              <div>
                <dt>Local government units</dt>
                <dd>{numberFormatter.format(VERIFIED_ALBAY_COVERAGE.localGovernmentUnits)}</dd>
              </div>
            </dl>
          </section>

          <p className="data-sources-disclaimer">
            No official warning data. This monitor is a situational-awareness tool, not a substitute for advisories
            from PAGASA or your local disaster risk reduction office.
          </p>
        </div>
      </div>
    </main>
  );
}
