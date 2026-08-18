import { DATA_SOURCES } from "@/lib/dataSources";
import {
  PAGASA_GAUGE_FRESHNESS_MINUTES,
  parseAlbayPagasaRainGauges
} from "@/lib/pagasaRainfall";

const OBSERVATION_CACHE_SECONDS = 120;

// The route itself must execute on request so a build can never freeze one
// PAGASA table snapshot into the application. The upstream fetch still uses a
// short Next.js data-cache window to avoid unnecessary load on the public site.
export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const retrievedAt = Date.now();
    const upstream = await fetch(DATA_SOURCES.officialRainfall.endpoint, {
      headers: {
        Accept: "text/html",
        "User-Agent": "Albay-Flood-Monitor/0.1"
      },
      next: { revalidate: OBSERVATION_CACHE_SECONDS },
      signal: AbortSignal.timeout(8_000)
    });

    if (!upstream.ok) {
      return Response.json(
        { error: `Official rainfall provider returned ${upstream.status}.` },
        { status: 502 }
      );
    }

    const stations = parseAlbayPagasaRainGauges(await upstream.text(), retrievedAt);

    return Response.json(
      {
        provider: DATA_SOURCES.officialRainfall.name,
        source_url: DATA_SOURCES.officialRainfall.endpoint,
        station_scope: "Albay",
        period: "preceding hour",
        unit: "mm",
        retrieved_at: new Date(retrievedAt).toISOString(),
        freshness_threshold_minutes: PAGASA_GAUGE_FRESHNESS_MINUTES,
        stations
      },
      {
        headers: {
          "Cache-Control": `public, s-maxage=${OBSERVATION_CACHE_SECONDS}, stale-while-revalidate=30`,
          "X-Rainfall-Source": DATA_SOURCES.officialRainfall.name,
          "X-Data-Provenance": "Station observations published by DOST-PAGASA"
        }
      }
    );
  } catch (error) {
    const message = error instanceof Error && error.name !== "TimeoutError"
      ? error.message
      : "Official rainfall provider is temporarily unavailable.";

    return Response.json({ error: message }, { status: 502 });
  }
}
