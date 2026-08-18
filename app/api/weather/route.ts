import { DATA_SOURCES } from "@/lib/dataSources";

const WEATHER_CACHE_SECONDS = 300;

type OpenMeteoPayload = {
  latitude?: unknown;
  longitude?: unknown;
  elevation?: unknown;
  utc_offset_seconds?: unknown;
  timezone?: unknown;
  current?: {
    time?: unknown;
    interval?: unknown;
    temperature_2m?: unknown;
    precipitation?: unknown;
    weather_code?: unknown;
    wind_speed_10m?: unknown;
    wind_direction_10m?: unknown;
  };
  hourly?: {
    time?: unknown;
    precipitation?: unknown;
    wind_speed_10m?: unknown;
    wind_direction_10m?: unknown;
  };
};

const isFiniteNumber = (value: unknown) => typeof value === "number" && Number.isFinite(value);

const isFiniteNumberArray = (value: unknown): value is number[] =>
  Array.isArray(value) && value.length > 0 && value.every(isFiniteNumber);

const isUsableWeatherPayload = (payload: OpenMeteoPayload) => {
  const hourly = payload.hourly;
  const current = payload.current;

  if (
    !isFiniteNumber(payload.latitude) ||
    !isFiniteNumber(payload.longitude) ||
    !isFiniteNumber(payload.elevation) ||
    !isFiniteNumber(payload.utc_offset_seconds) ||
    typeof payload.timezone !== "string" ||
    !current ||
    typeof current.time !== "string" ||
    !isFiniteNumber(current.interval) ||
    !isFiniteNumber(current.temperature_2m) ||
    !isFiniteNumber(current.precipitation) ||
    !isFiniteNumber(current.weather_code) ||
    !isFiniteNumber(current.wind_speed_10m) ||
    !isFiniteNumber(current.wind_direction_10m) ||
    !hourly ||
    !Array.isArray(hourly.time) ||
    !isFiniteNumberArray(hourly.precipitation) ||
    !isFiniteNumberArray(hourly.wind_speed_10m) ||
    !isFiniteNumberArray(hourly.wind_direction_10m)
  ) {
    return false;
  }

  const expectedLength = hourly.time.length;
  return (
    expectedLength > 0 &&
    hourly.time.every((time) => typeof time === "string") &&
    hourly.precipitation.length === expectedLength &&
    hourly.wind_speed_10m.length === expectedLength &&
    hourly.wind_direction_10m.length === expectedLength
  );
};

const parseCoordinate = (value: string | null, min: number, max: number) => {
  if (value === null || value.trim() === "") return null;

  const coordinate = Number(value);
  return Number.isFinite(coordinate) && coordinate >= min && coordinate <= max ? coordinate : null;
};

export async function GET(request: Request) {
  const { searchParams } = new URL(request.url);
  const latitude = parseCoordinate(searchParams.get("latitude"), -90, 90);
  const longitude = parseCoordinate(searchParams.get("longitude"), -180, 180);

  if (latitude === null || longitude === null) {
    return Response.json(
      { error: "Valid latitude and longitude query parameters are required." },
      { status: 400 }
    );
  }

  const params = new URLSearchParams({
    latitude: latitude.toString(),
    longitude: longitude.toString(),
    current: "temperature_2m,precipitation,weather_code,wind_speed_10m,wind_direction_10m",
    hourly: "precipitation,wind_speed_10m,wind_direction_10m",
    timezone: "auto",
    precipitation_unit: "mm",
    wind_speed_unit: "kmh",
    timeformat: "iso8601",
    cell_selection: "land",
    models: "best_match",
    past_days: "2",
    forecast_days: "3"
  });

  try {
    const upstream = await fetch(`${DATA_SOURCES.weather.endpoint}?${params.toString()}`, {
      headers: { Accept: "application/json" },
      next: { revalidate: WEATHER_CACHE_SECONDS }
    });

    if (!upstream.ok) {
      return Response.json(
        { error: `Weather provider returned ${upstream.status}.` },
        { status: 502 }
      );
    }

    const weather = (await upstream.json()) as OpenMeteoPayload;

    if (!isUsableWeatherPayload(weather)) {
      return Response.json(
        { error: "Weather provider returned an incomplete or invalid model dataset." },
        { status: 502 }
      );
    }

    return Response.json({
      ...weather,
      _provenance: {
        provider: DATA_SOURCES.weather.name,
        documentation_url: DATA_SOURCES.weather.documentationUrl,
        dataset: "best_match numerical weather forecast",
        served_at: new Date().toISOString(),
        requested_coordinates: { latitude, longitude }
      }
    }, {
      headers: {
        "Cache-Control": `public, s-maxage=${WEATHER_CACHE_SECONDS}, stale-while-revalidate=60`,
        "X-Weather-Source": DATA_SOURCES.weather.name,
        "X-Data-Provenance": "Open-Meteo best_match numerical weather-model output"
      }
    });
  } catch {
    return Response.json(
      { error: "Weather provider is temporarily unavailable." },
      { status: 502 }
    );
  }
}
