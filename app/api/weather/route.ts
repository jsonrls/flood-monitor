const WEATHER_CACHE_SECONDS = 300;

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
    current: "temperature_2m,precipitation,weather_code",
    hourly: "precipitation",
    timezone: "auto",
    past_days: "2",
    forecast_days: "3"
  });

  try {
    const upstream = await fetch(`https://api.open-meteo.com/v1/forecast?${params.toString()}`, {
      headers: { Accept: "application/json" },
      next: { revalidate: WEATHER_CACHE_SECONDS }
    });

    if (!upstream.ok) {
      return Response.json(
        { error: `Weather provider returned ${upstream.status}.` },
        { status: 502 }
      );
    }

    const weather = await upstream.json();

    return Response.json(weather, {
      headers: {
        "Cache-Control": `public, s-maxage=${WEATHER_CACHE_SECONDS}, stale-while-revalidate=60`,
        "X-Weather-Source": "Open-Meteo model data"
      }
    });
  } catch {
    return Response.json(
      { error: "Weather provider is temporarily unavailable." },
      { status: 502 }
    );
  }
}
