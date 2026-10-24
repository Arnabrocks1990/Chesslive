import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// Dev: UI on :5174, API proxied to the admin server on :8003. Production: the admin server serves dist/ itself.
export default defineConfig({
  plugins: [react()],
  server: { port: 5174, proxy: { "/api": "http://localhost:8003" } },
});
