import { ImageResponse } from "next/og";
import { K_MARK } from "@/lib/brand/k-mark";
import { SITE } from "@/lib/site";

/** Social preview for /links (shared links on WhatsApp, Facebook, Instagram…). */
export const alt = `${SITE.name}: ${SITE.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpenGraphImage() {
  const { x, y, width, height } = K_MARK.viewBox;
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          gap: 64,
          background: "#163a2c",
          padding: 80,
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            width: 280,
            height: 280,
            borderRadius: 56,
            background: "#ffffff",
          }}
        >
          <svg viewBox={`${x} ${y} ${width} ${height}`} width={200} height={(200 * height) / width}>
            {K_MARK.paths.map((path) => (
              <path key={path.fill} fill={path.fill} d={path.d} />
            ))}
          </svg>
        </div>
        <div style={{ display: "flex", flexDirection: "column" }}>
          <div style={{ fontSize: 88, fontWeight: 700, color: "#ffffff" }}>{SITE.name}</div>
          <div style={{ marginTop: 12, fontSize: 48, color: "#c3e604" }}>{SITE.tagline}</div>
          <div style={{ marginTop: 28, fontSize: 30, color: "rgba(255, 255, 255, 0.8)" }}>
            Pre-loved shoes for men and women · New for kids
          </div>
        </div>
      </div>
    ),
    size,
  );
}
