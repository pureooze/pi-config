import { writeFileSync } from "node:fs";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

export default function piSmokeExtension(pi: ExtensionAPI): void {
  pi.on("session_start", (_event, ctx) => {
    const markerPath = process.env.PI_KG_SMOKE_MARKER;
    if (!markerPath) {
      throw new Error("PI_KG_SMOKE_MARKER is required");
    }
    writeFileSync(markerPath, "loaded\n", { encoding: "utf8", mode: 0o600 });
    ctx.shutdown();
  });
}
