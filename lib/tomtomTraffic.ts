const TILE_CACHE_TTL_MS = 3 * 60 * 1000;
const TILE_CACHE_MAX_ENTRIES = 600;
// Stay under TomTom's 2,500/day free tier with headroom for other instances;
// a 403/429 from TomTom is the authoritative signal and blocks until reset.
const DAILY_REQUEST_SOFT_LIMIT = 2_300;

type CachedTile = {
  expiresAt: number;
  body: ArrayBuffer;
  contentType: string;
};

const tileCache = new Map<string, CachedTile>();

let blockedUntil = 0;
let requestDayKey = "";
let requestsToday = 0;

const currentDayKey = () => new Date().toISOString().slice(0, 10);

const nextUtcMidnight = () => {
  const next = new Date();
  next.setUTCHours(24, 0, 0, 0);
  return next.valueOf();
};

export const getTomTomApiKey = () => process.env.TOMTOM_API_KEY || null;

export const isTomTomAvailable = () => {
  if (!getTomTomApiKey()) return false;
  if (Date.now() < blockedUntil) return false;

  if (requestDayKey !== currentDayKey()) {
    requestDayKey = currentDayKey();
    requestsToday = 0;
  }
  return requestsToday < DAILY_REQUEST_SOFT_LIMIT;
};

export const blockTomTomUntilReset = () => {
  blockedUntil = nextUtcMidnight();
};

export const countTomTomRequest = () => {
  if (requestDayKey !== currentDayKey()) {
    requestDayKey = currentDayKey();
    requestsToday = 0;
  }
  requestsToday += 1;
};

export const readCachedTile = (key: string): CachedTile | null => {
  const entry = tileCache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    tileCache.delete(key);
    return null;
  }
  return entry;
};

export const writeCachedTile = (key: string, body: ArrayBuffer, contentType: string) => {
  if (tileCache.size >= TILE_CACHE_MAX_ENTRIES) {
    const oldestKey = tileCache.keys().next().value;
    if (oldestKey !== undefined) tileCache.delete(oldestKey);
  }
  tileCache.set(key, { expiresAt: Date.now() + TILE_CACHE_TTL_MS, body, contentType });
};
