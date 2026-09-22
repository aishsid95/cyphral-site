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
 *
 * Also adds the "service_binding_extra_handlers" compatibility flag, test-
 * only, so routes.integration.test.ts can call `exports.default.scheduled()`
 * on the already-running built worker to test src/worker.ts's cron handler.
 * That's the only viable way to reach it here: src/worker.ts imports
 * @astrojs/cloudflare/handler, which imports an Astro-internal Vite virtual
 * module that only resolves inside Astro's own build — a test file can't
 * import src/worker.ts directly and re-resolve it (confirmed empirically;
 * see https://developers.cloudflare.com/workers/testing/vitest-integration/known-issues/#module-resolution).
 * This flag is Cloudflare-documented as experimental for exactly this use
 * (per their own vitest-plugin example fixtures) and is never added to the
 * real wrangler.jsonc — production's compatibility_flags stay untouched.
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
  config.compatibility_flags = [...new Set([...(config.compatibility_flags ?? []), 'service_binding_extra_handlers'])];
  await writeFile(outputPath, JSON.stringify(config, null, 2), 'utf8');
  console.log(
    `Wrote ${outputPath} (legacy_env stripped, service_binding_extra_handlers added — both test-only, see file header)`,
  );
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
