import { isTomTomAvailable } from "@/lib/tomtomTraffic";

export const dynamic = "force-dynamic";

export async function GET() {
  return Response.json(
    { provider: isTomTomAvailable() ? "tomtom" : "mapbox" },
    { headers: { "Cache-Control": "no-store" } }
  );
}
