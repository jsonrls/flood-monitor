import FloodMap from "@/components/FloodMap";
import { Analytics } from "@vercel/analytics/next"

export default function HomePage() {
  return <>
    <FloodMap />
    <Analytics />
  </>
}
