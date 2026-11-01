import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react()],
  server: {
    host: "127.0.0.1",
    port: 4176,
    proxy: {
      "/api": "http://127.0.0.1:4175",
      "/healthz": "http://127.0.0.1:4175",
      "/readyz": "http://127.0.0.1:4175",
    },
  },
  preview: {
    host: "127.0.0.1",
    port: 4176,
  },
});
