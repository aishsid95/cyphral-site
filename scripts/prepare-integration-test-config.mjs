#!/usr/bin/env node
/**
 * `astro build` (via @astrojs/cloudflare, bundling an older wrangler) writes
 * dist/server/wrangler.json with a "legacy_env": true field. The newer
 * wrangler bundled inside @cloudflare/vitest-plugin's own node_modules has
 * removed support for that field and refuses to start with it present.
 *
 * Rather than touch the real build artifact (which Cloudflare Workers Builds
 * deploys as-is), this writes a second, test-only copy with that one field
 * stripped. vitest.integration.config.ts points at the copy, never the
 * original. Run automatically via the `pretest:integration` npm script,
 * after `npm run build`.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const distServerDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../dist/server');
const sourcePath = path.join(distServerDir, 'wrangler.json');
const outputPath = path.join(distServerDir, 'wrangler.integration-test.json');

async function main() {
  const raw = await readFile(sourcePath, 'utf8');
  const config = JSON.parse(raw);
  delete config.legacy_env;
  await writeFile(outputPath, JSON.stringify(config, null, 2), 'utf8');
  console.log(`Wrote ${outputPath} (legacy_env stripped for the vitest-plugin's bundled wrangler)`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
