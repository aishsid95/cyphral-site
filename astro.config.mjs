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
    plugins: [tailwindcss()]
  },

  adapter: cloudflare(),
  integrations: [sitemap()]
});