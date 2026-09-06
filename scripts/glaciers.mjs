#!/usr/bin/env node
/**
 * Every glacier on Earth, from the Randolph Glacier Inventory v7.
 *
 * RGI is a complete global inventory rather than a sample: every glacier
 * outline on the planet, digitised from satellite imagery, with a centroid,
 * an area and minimum, maximum and median elevations for each.
 *
 * Downloads the global attributes table, which is a CSV, so the renderer reads
 * it with no conversion at all - this script only fetches it.
 *
 * Note the source is the OGGM mirror. The official NSIDC distribution requires
 * an Earthdata login and the GLIMS path for the previous version has gone.
 */

import { createWriteStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const URL = 'https://cluster.klima.uni-bremen.de/~oggm/rgi/RGI2000-v7.0-G-global-attributes.csv';
const OUT = 'data/glaciers.csv';

if (existsSync(OUT)) {
  console.log(`${OUT} already present`);
  process.exit(0);
}

console.log('fetching Randolph Glacier Inventory v7 attributes (71 MB)...');
const response = await fetch(URL);
if (!response.ok) throw new Error(`${response.status} fetching RGI`);
await pipeline(Readable.fromWeb(response.body), createWriteStream(OUT));
console.log(`${OUT} — ${(statSync(OUT).size / 1e6).toFixed(1)} MB`);
