import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { VitePWA } from "vite-plugin-pwa";

export default defineConfig({
  plugins: [
    react(),
    // PWA: precache the SPA shell + assets (Workbox `generateSW`) so the app
    // installs and boots offline. `/api` and `/assets` are kept off the
    // navigation fallback so live server routes are never shadowed by the shell.
    // The offline note backend itself is the IndexedDB `BrowserGitEngine`
    // (see ADR 0011); this plugin only owns the installable, cached shell.
    VitePWA({
      registerType: "autoUpdate",
      includeAssets: ["icon.svg"],
      manifest: {
        name: "Stout",
        short_name: "Stout",
        description: "A local-first, Git-backed Markdown notebook.",
        theme_color: "#111415",
        background_color: "#111415",
        display: "standalone",
        // The installed PWA boots the offline runtime (server-free, IndexedDB
        // backend); the web app served at `/` keeps the server runtime. ADR 0011.
        start_url: "/?runtime=offline",
        scope: "/",
        icons: [
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "any" },
          { src: "icon.svg", sizes: "any", type: "image/svg+xml", purpose: "maskable" },
        ],
      },
      workbox: {
        navigateFallback: "index.html",
        navigateFallbackDenylist: [/^\/api\//, /^\/assets\//],
        globPatterns: ["**/*.{js,css,html,svg,woff,woff2}"],
        cleanupOutdatedCaches: true,
      },
    }),
  ],
  build: {
    outDir: "dist",
    emptyOutDir: true,
  },
  server: {
    proxy: {
      "/api": "http://localhost:3000",
    },
  },
  test: {
    environment: "jsdom",
  },
});
