const PHILIPPINES_UTC_OFFSET_MS = 8 * 60 * 60 * 1000;

export const PAGASA_GAUGE_FRESHNESS_MINUTES = 60;

export type PagasaGaugeFreshness = "current" | "stale" | "unavailable";

export type PagasaRainGaugeObservation = {
  site_id: string;
  site_name: string;
  hourly_rain_mm: number | null;
  elevation_m: number | null;
  observed_at: string | null;
  freshness: PagasaGaugeFreshness;
};

const MONTH_INDEX: Record<string, number> = {
  january: 0,
  february: 1,
  march: 2,
  april: 3,
  may: 4,
  june: 5,
  july: 6,
  august: 7,
  september: 8,
  october: 9,
  november: 10,
  december: 11
};

const decodeHtmlText = (value: string) =>
  value
    .replace(/<[^>]*>/g, " ")
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&quot;/gi, '"')
    .replace(/&#(?:39|x27);/gi, "'")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/\s+/g, " ")
    .trim();

const isMissingValue = (value: string) => !value || /^-{1,2}$/.test(value);

const parseOptionalNumber = (value: string, maximum: number): number | null | undefined => {
  if (isMissingValue(value)) return null;

  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed >= 0 && parsed <= maximum ? parsed : undefined;
};

const parsePagasaLocalTime = (value: string) => {
  const match = value.match(
    /^(January|February|March|April|May|June|July|August|September|October|November|December)\s+(\d{1,2}),\s*(\d{4}),\s*(\d{1,2}):(\d{2})\s*(am|pm)$/i
  );

  if (!match) return null;

  const month = MONTH_INDEX[match[1].toLowerCase()];
  const day = Number(match[2]);
  const year = Number(match[3]);
  const rawHour = Number(match[4]);
  const minute = Number(match[5]);
  const meridiem = match[6].toLowerCase();

  if (
    month === undefined ||
    !Number.isInteger(day) ||
    day < 1 ||
    day > 31 ||
    !Number.isInteger(year) ||
    year < 2000 ||
    year > 2200 ||
    !Number.isInteger(rawHour) ||
    rawHour < 1 ||
    rawHour > 12 ||
    !Number.isInteger(minute) ||
    minute < 0 ||
    minute > 59
  ) {
    return null;
  }

  const hour = (rawHour % 12) + (meridiem === "pm" ? 12 : 0);
  const utcTimestamp = Date.UTC(year, month, day, hour, minute) - PHILIPPINES_UTC_OFFSET_MS;
  const localDateCheck = new Date(utcTimestamp + PHILIPPINES_UTC_OFFSET_MS);

  if (
    localDateCheck.getUTCFullYear() !== year ||
    localDateCheck.getUTCMonth() !== month ||
    localDateCheck.getUTCDate() !== day ||
    localDateCheck.getUTCHours() !== hour ||
    localDateCheck.getUTCMinutes() !== minute
  ) {
    return null;
  }

  const pad = (part: number) => String(part).padStart(2, "0");
  return {
    timestamp: utcTimestamp,
    iso: `${year}-${pad(month + 1)}-${pad(day)}T${pad(hour)}:${pad(minute)}:00+08:00`
  };
};

export const parseAlbayPagasaRainGauges = (
  html: string,
  retrievedAt = Date.now()
): PagasaRainGaugeObservation[] => {
  if (!html.includes("Latest Automated Rain Gauges")) {
    throw new Error("PAGASA response did not contain the automated rain-gauge table.");
  }

  const rows = Array.from(html.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi));
  const observations: PagasaRainGaugeObservation[] = [];

  rows.forEach((row) => {
    const cells = Array.from(row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)).map((cell) =>
      decodeHtmlText(cell[1])
    );

    if (cells.length !== 5) return;

    const [siteId, siteName, rainText, elevationText, observedText] = cells;
    if (!/^\d+$/.test(siteId) || !/\bAlbay\b/i.test(siteName)) return;

    const rain = parseOptionalNumber(rainText, 1_000);
    const elevation = parseOptionalNumber(elevationText, 10_000);
    const observationTime = isMissingValue(observedText) ? null : parsePagasaLocalTime(observedText);

    if (rain === undefined || elevation === undefined || (!isMissingValue(observedText) && !observationTime)) {
      throw new Error(`PAGASA returned an invalid value for Albay station ${siteId}.`);
    }

    const ageMs = observationTime ? retrievedAt - observationTime.timestamp : Number.POSITIVE_INFINITY;
    const isPlausiblyTimed = ageMs >= -15 * 60_000;
    const freshness: PagasaGaugeFreshness =
      rain === null || !observationTime
        ? "unavailable"
        : isPlausiblyTimed && ageMs <= PAGASA_GAUGE_FRESHNESS_MINUTES * 60_000
          ? "current"
          : "stale";

    observations.push({
      site_id: siteId,
      site_name: siteName,
      hourly_rain_mm: rain,
      elevation_m: elevation,
      observed_at: observationTime?.iso ?? null,
      freshness
    });
  });

  if (observations.length === 0) {
    throw new Error("PAGASA response did not contain any Albay rain-gauge stations.");
  }

  return observations.sort((a, b) => a.site_name.localeCompare(b.site_name));
};
