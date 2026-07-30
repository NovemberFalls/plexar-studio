import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import pkg from "./package.json" with { type: "json" };

export default defineConfig({
  plugins: [react()],
  // Surfaced in the status strip as "v<app>". Read from package.json — the same
  // number the version bump and the Tauri installer use — so the running app can
  // never report a version that disagrees with the build it came from.
  define: {
    "import.meta.env.VITE_APP_VERSION": JSON.stringify(pkg.version),
  },
  server: {
    port: 5174,
    strictPort: true,
    host: process.env.TAURI_DEV_HOST || false,
    proxy: {
      "/api": "http://localhost:8420",
      "/ws": {
        target: "ws://localhost:8420",
        ws: true,
        // Suppress ECONNABORTED noise when WS connections drop during HMR/reload
        configure: (proxy) => {
          proxy.on("error", (err) => {
            if (err.code !== "ECONNABORTED" && err.code !== "ECONNRESET") {
              console.error("[ws proxy]", err.message);
            }
          });
        },
      },
      "/login": "http://localhost:8420",
      "/logout": "http://localhost:8420",
      "/auth": "http://localhost:8420",
    },
  },
});
