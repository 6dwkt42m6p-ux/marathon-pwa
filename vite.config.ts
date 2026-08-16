import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

// GitHub Pages deploys to /<repo-name>/ — set base accordingly
const base = process.env.GITHUB_ACTIONS ? '/marathon-pwa/' : '/'

export default defineConfig({
  base,
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
    // T-171: deterministische Test-Umgebung. `TOKEN_PROXY` wird in strava.ts auf
    // MODULEBENE aus import.meta.env gelesen, ist zur Laufzeit also nicht mehr
    // stubbar. Ohne diesen Wert zog der Test seine Konfiguration aus der lokalen,
    // gitignorierten .env — er war deshalb lokal gruen und faellt in der CI mit
    // "VITE_STRAVA_TOKEN_PROXY not configured" durch (aufgedeckt, als vitest zum
    // ersten Mal ueberhaupt in der CI lief). Ein Unit-Test ueber Storage-Quota darf
    // nicht an einem Deployment-Secret haengen; fetch ist im Test ohnehin gestubbt,
    // der Wert wird nie kontaktiert.
    env: {
      VITE_STRAVA_TOKEN_PROXY: 'https://token-proxy.invalid',
      VITE_STRAVA_CLIENT_ID: '0',
      VITE_STRAVA_REDIRECT_URI: 'https://app.invalid/callback',
    },
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.svg'],
      manifest: {
        name: 'Marathon Coach',
        short_name: 'Coach',
        description: 'Lauftraining & Wettkampfvorbereitung',
        theme_color: '#1C2333',
        background_color: '#1C2333',
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icons/icon-192.svg', sizes: '192x192', type: 'image/svg+xml' },
          { src: 'icons/icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        runtimeCaching: [
          {
            urlPattern: /^https:\/\/www\.strava\.com\/api\//,
            handler: 'NetworkFirst',
            options: { cacheName: 'strava-api', networkTimeoutSeconds: 8 },
          },
        ],
      },
    }),
  ],
})
