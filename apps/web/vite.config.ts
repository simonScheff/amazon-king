/// <reference types="vitest/config" />
import react from "@vitejs/plugin-react";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";

export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true,
    // Allow cloudflared quick-tunnel subdomains so the dev server can be
    // reached over HTTPS (needed for PWA install testing on phones).
    allowedHosts: [".trycloudflare.com"],
    proxy: {
      "/api": {
        // Override with VITE_API_PROXY_TARGET to point the dev server at a
        // non-default API (e.g. the demo seed on :3100).
        target: process.env.VITE_API_PROXY_TARGET ?? "http://localhost:3000",
        changeOrigin: true,
      },
    },
  },
  test: {
    environment: "jsdom",
    setupFiles: ["./src/test/setup.ts"],
    include: ["src/**/*.test.{ts,tsx}"],
  },
});
