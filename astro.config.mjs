// @ts-check
import { defineConfig } from 'astro/config';

import tailwindcss from '@tailwindcss/vite';

import cloudflare from '@astrojs/cloudflare';

import sitemap from '@astrojs/sitemap';

// https://astro.build/config
export default defineConfig({
  // Canonical site URL. Required for correct canonical links and sitemap output.
  site: 'https://cyphral.co.uk',

  vite: {
    plugins: [tailwindcss()],
    // Astro inlines any processed <script> under this many bytes (Vite's own
    // small-asset optimisation, reused for script hoisting). 0 disables it,
    // so every script — however small — is always emitted as an external
    // file with a real src=. Needed for /book*'s CSP (script-src 'self',
    // no 'unsafe-inline'); harmless everywhere else (just one small extra
    // request per page instead of an inlined blob).
    build: {
      assetsInlineLimit: 0
    }
  },

  adapter: cloudflare(),
  integrations: [
    sitemap({
      // Token-gated dead ends with no useful content without a visitor's own
      // link — see the noindex prop on these two pages' <Layout> as well.
      filter: (page) => !page.includes('/book/confirm') && !page.includes('/book/cancel')
    })
  ]
});