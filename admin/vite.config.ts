import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: UI on :5174, API proxied to the admin server on :8003. Production: the admin server serves dist/ itself.
export default defineConfig({
  base: "./", // works from / (local dashboard) and from /admin/ (mounted on the game server)
  plugins: [react()],
  server: { port: 5174, proxy: { "/api": "http://localhost:8003" } },
});
