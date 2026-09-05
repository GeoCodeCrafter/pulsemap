#!/usr/bin/env node
/**
 * Downloads the WRI Global Power Plant Database.
 *
 * No transformation: the renderer reads this CSV exactly as published, which is
 * the point of the CSV support. Naming the latitude and longitude columns in
 * the config is the entire setup.
 */

import { createWriteStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const URL =
  'https://raw.githubusercontent.com/wri/global-power-plant-database/master/output_database/global_power_plant_database.csv';
const OUT = 'data/power-plants.csv';

if (existsSync(OUT)) {
  console.log(`${OUT} already present`);
  process.exit(0);
}

console.log('fetching WRI Global Power Plant Database (12 MB)...');
const response = await fetch(URL);
if (!response.ok) throw new Error(`${response.status} from GitHub`);
await pipeline(Readable.fromWeb(response.body), createWriteStream(OUT));
console.log(`${OUT} — ${(statSync(OUT).size / 1e6).toFixed(1)} MB`);
