import {
  blockTomTomUntilReset,
  countTomTomRequest,
  getTomTomApiKey,
  isTomTomAvailable,
  readCachedTile,
  writeCachedTile
} from "@/lib/tomtomTraffic";

const MIN_ZOOM = 5;
const MAX_ZOOM = 18;
const BROWSER_CACHE_SECONDS = 120;

const parseTileCoordinate = (value: string | null) => {
  if (value === null || !/^\d{1,7}$/.test(value)) return null;
  return Number.parseInt(value, 10);
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const z = parseTileCoordinate(searchParams.get("z"));
  const x = parseTileCoordinate(searchParams.get("x"));
  const y = parseTileCoordinate(searchParams.get("y"));

  if (z === null || x === null || y === null || z < MIN_ZOOM || z > MAX_ZOOM) {
    return Response.json({ error: "Invalid tile coordinates." }, { status: 400 });
  }
  const tilesPerAxis = 2 ** z;
  if (x >= tilesPerAxis || y >= tilesPerAxis) {
    return Response.json({ error: "Invalid tile coordinates." }, { status: 400 });
  }

  const cacheKey = `${z}/${x}/${y}`;
  const cached = readCachedTile(cacheKey);
  if (cached) {
    return new Response(cached.body, {
      headers: {
        "Content-Type": cached.contentType,
        "Cache-Control": `public, max-age=${BROWSER_CACHE_SECONDS}`
      }
    });
  }

  const apiKey = getTomTomApiKey();
  if (!apiKey || !isTomTomAvailable()) {
    return Response.json({ error: "TomTom traffic is unavailable." }, { status: 503 });
  }

  try {
    countTomTomRequest();
    const upstream = await fetch(
      `https://api.tomtom.com/traffic/map/4/tile/flow/relative0/${z}/${x}/${y}.png?key=${apiKey}`,
      { cache: "no-store" }
    );

    if (upstream.status === 403 || upstream.status === 429) {
      blockTomTomUntilReset();
      return Response.json({ error: "TomTom traffic quota reached." }, { status: 503 });
    }
    if (!upstream.ok) {
      return Response.json({ error: `TomTom traffic returned ${upstream.status}.` }, { status: 502 });
    }

    const body = await upstream.arrayBuffer();
    const contentType = upstream.headers.get("Content-Type") || "image/png";
    writeCachedTile(cacheKey, body, contentType);

    return new Response(body, {
      headers: {
        "Content-Type": contentType,
        "Cache-Control": `public, max-age=${BROWSER_CACHE_SECONDS}`
      }
    });
  } catch {
    return Response.json({ error: "TomTom traffic request failed." }, { status: 502 });
  }
}
