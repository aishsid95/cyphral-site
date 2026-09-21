#!/usr/bin/env node
/**
 * Downloads UK bank holiday dates (England and Wales) from gov.uk and writes
 * worker/booking/bank-holidays.json. Run manually and commit the result.
 *
 * There is no runtime fetch anywhere in the booking system — the deployed
 * site never depends on gov.uk being reachable. If the committed data falls
 * behind (gov.uk hasn't published next year's dates yet, or this script
 * hasn't been re-run), the availability engine fails closed: it returns no
 * slots for any date beyond the last date in this file, rather than risking
 * an undocumented bank holiday being offered as bookable.
 *
 * Usage: node scripts/fetch-bank-holidays.mjs
 */

import { writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const SOURCE_URL = 'https://www.gov.uk/bank-holidays.json';
const DIVISION = 'england-and-wales';
const OUTPUT_PATH = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../worker/booking/bank-holidays.json',
);

async function main() {
  const res = await fetch(SOURCE_URL);
  if (!res.ok) {
    throw new Error(`Failed to fetch ${SOURCE_URL}: ${res.status} ${res.statusText}`);
  }
  const data = await res.json();
  const division = data[DIVISION];
  if (!division || !Array.isArray(division.events)) {
    throw new Error('Unexpected response shape from gov.uk bank holidays endpoint');
  }

  const dates = division.events
    .map((event) => event.date)
    .filter((date) => typeof date === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(date))
    .sort();

  if (dates.length === 0) {
    throw new Error('gov.uk response contained no usable dates — refusing to write an empty file');
  }

  const output = {
    source: SOURCE_URL,
    division: DIVISION,
    fetchedAt: new Date().toISOString(),
    dates,
  };

  await writeFile(OUTPUT_PATH, `${JSON.stringify(output, null, 2)}\n`, 'utf8');
  console.log(`Wrote ${dates.length} bank holiday dates (through ${dates[dates.length - 1]}) to ${OUTPUT_PATH}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
