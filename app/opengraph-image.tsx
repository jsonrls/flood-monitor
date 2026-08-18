/* eslint-disable @next/next/no-img-element */
import { readFile } from "fs/promises";
import { join } from "path";
import { ImageResponse } from "next/og";

export const alt = "Albay Province live rain and flood intelligence map";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default async function OpenGraphImage() {
  const logoSvg = await readFile(join(process.cwd(), "logo.svg"), "utf8");
  const logoDataUri = `data:image/svg+xml;base64,${Buffer.from(logoSvg).toString("base64")}`;

  return new ImageResponse(
    (
      <div
        style={{
          alignItems: "stretch",
          background: "#eef0ed",
          color: "#0d1112",
          display: "flex",
          flexDirection: "column",
          height: "100%",
          padding: "44px",
          width: "100%"
        }}
      >
        <div
          style={{
            alignItems: "center",
            borderBottom: "2px solid #0d1112",
            display: "flex",
            justifyContent: "space-between",
            paddingBottom: "22px"
          }}
        >
          <div style={{ alignItems: "center", display: "flex", gap: "18px" }}>
            <img src={logoDataUri} alt="" width="72" height="72" style={{ borderRadius: "15px" }} />
            <div style={{ display: "flex", flexDirection: "column" }}>
              <div style={{ fontSize: "31px", fontWeight: 800, letterSpacing: "-1px" }}>Flood Monitor</div>
              <div style={{ color: "#596267", fontSize: "15px", letterSpacing: "3px", textTransform: "uppercase" }}>
                GIS flood intelligence
              </div>
            </div>
          </div>
          <div
            style={{
              alignItems: "center",
              border: "2px solid #147d51",
              color: "#147d51",
              display: "flex",
              fontSize: "15px",
              fontWeight: 700,
              gap: "10px",
              letterSpacing: "2px",
              padding: "11px 15px",
              textTransform: "uppercase"
            }}
          >
            <span style={{ background: "#20c779", borderRadius: "50%", display: "flex", height: "12px", width: "12px" }} />
            Live Albay model
          </div>
        </div>

        <div style={{ display: "flex", flex: 1, gap: "48px", paddingTop: "36px" }}>
          <div style={{ display: "flex", flex: 1, flexDirection: "column", justifyContent: "center" }}>
            <div style={{ color: "#596267", fontSize: "16px", letterSpacing: "3px", textTransform: "uppercase" }}>
              Rain • terrain • waterways
            </div>
            <div
              style={{
                fontSize: "62px",
                fontWeight: 900,
                letterSpacing: "-3px",
                lineHeight: 0.98,
                marginTop: "17px",
                maxWidth: "650px"
              }}
            >
              Flood conditions across Albay Province.
            </div>
            <div style={{ color: "#40484c", fontSize: "22px", lineHeight: 1.4, marginTop: "22px", maxWidth: "650px" }}>
              Near-real-time rainfall, local risk estimates, 3D satellite terrain, and nearby Albay river networks in one civic map.
            </div>
          </div>

          <div
            style={{
              alignItems: "center",
              background: "#0E3550",
              border: "2px solid #0d1112",
              boxShadow: "12px 12px 0 #0d1112",
              display: "flex",
              height: "350px",
              justifyContent: "center",
              overflow: "hidden",
              position: "relative",
              width: "350px"
            }}
          >
            <div
              style={{
                border: "2px solid rgba(247,245,239,0.28)",
                borderRadius: "50%",
                display: "flex",
                height: "285px",
                position: "absolute",
                width: "285px"
              }}
            />
            <div
              style={{
                border: "2px solid rgba(247,245,239,0.28)",
                borderRadius: "50%",
                display: "flex",
                height: "220px",
                position: "absolute",
                width: "220px"
              }}
            />
            <img src={logoDataUri} alt="" width="172" height="172" style={{ borderRadius: "37px", position: "relative" }} />
            <div
              style={{
                background: "#8FE9F2",
                bottom: "48px",
                display: "flex",
                height: "3px",
                left: "22px",
                position: "absolute",
                transform: "rotate(-8deg)",
                width: "305px"
              }}
            />
          </div>
        </div>

        <div
          style={{
            borderTop: "1px solid #aab0ab",
            color: "#596267",
            display: "flex",
            fontSize: "14px",
            justifyContent: "space-between",
            letterSpacing: "2px",
            paddingTop: "18px",
            textTransform: "uppercase"
          }}
        >
          <span>18 LGUs • 720 barangays • Bicol Region</span>
          <span>Open-Meteo • Mapbox • GIS</span>
        </div>
      </div>
    ),
    size
  );
}
