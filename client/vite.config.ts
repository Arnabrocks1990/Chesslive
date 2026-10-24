import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev the UI runs on :5173 and proxies API + websocket traffic to the game server on :8001.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      "/api": "http://localhost:8001",
      "/socket.io": { target: "http://localhost:8001", ws: true },
    },
  },
});
