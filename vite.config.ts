import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icons/*.png'],
      manifest: {
        name: 'Marathon Coach',
        short_name: 'Coach',
        description: 'Lauftraining & Wettkampfvorbereitung',
        theme_color: '#1C2333',
        background_color: '#1C2333',
        display: 'standalone',
        orientation: 'portrait',
        start_url: '/',
        icons: [
          { src: 'icons/icon-192.svg', sizes: '192x192', type: 'image/svg+xml' },
          { src: 'icons/icon-512.svg', sizes: '512x512', type: 'image/svg+xml', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2,ts}'],
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
