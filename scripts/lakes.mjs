#!/usr/bin/env node
/**
 * Every lake on Earth, from HydroLAKES.
 *
 * The points release rather than the polygons: 1.4 million lake outlines is
 * 782 MB and, drawn at world scale, every one of them below the great lakes is
 * smaller than a pixel anyway. The points file carries the same attributes -
 * area, depth, volume, shoreline, elevation - at a tenth of the size.
 *
 * Same provenance as the rivers, which is why it clears the coverage bar: the
 * inventory is built from satellite imagery and a global elevation model, not
 * assembled from what each country chose to report.
 */

import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { open } from 'shapefile';

const URL = 'https://data.hydrosheds.org/file/hydrolakes/HydroLAKES_points_v10_shp.zip';
const ZIP = 'data/HydroLAKES_points_v10_shp.zip';
const SOURCE = 'data/HydroLAKES_points_v10_shp/HydroLAKES_points_v10.shp';
const OUT = 'data/lakes.geojson';

if (!existsSync(SOURCE)) {
  if (!existsSync(ZIP)) {
    console.log('fetching HydroLAKES points (75 MB)...');
    const response = await fetch(URL);
    if (!response.ok) throw new Error(`${response.status} from hydrosheds`);
    await pipeline(Readable.fromWeb(response.body), createWriteStream(ZIP));
  }
  console.log(`unzip ${ZIP} into data/ then run again`);
  process.exit(1);
}

const out = createWriteStream(OUT);
out.write('{"type":"FeatureCollection","features":[\n');

const source = await open(SOURCE, undefined, { encoding: 'utf8' });

let read = 0;
let kept = 0;
let elevations = 0;

for (let result = await source.read(); !result.done; result = await source.read()) {
  read += 1;
  if (read % 200_000 === 0) process.stdout.write(`\r  read ${read.toLocaleString()}`);

  const feature = result.value;
  const [lon, lat] = feature?.geometry?.coordinates ?? [];
  if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;

  const p = feature.properties ?? {};
  const area = Number(p.Lake_area);
  const elevation = Number(p.Elevation);
  if (!Number.isFinite(area) || area <= 0) continue;
  if (!Number.isFinite(elevation)) continue;
  elevations += 1;

  out.write(
    `${kept ? ',\n' : ''}{"type":"Feature","properties":{"a":${round(area, 3)},` +
      `"e":${Math.round(elevation)},"d":${round(Number(p.Depth_avg) || 0, 2)}},` +
      `"geometry":{"type":"Point","coordinates":[${round(lon, 4)},${round(lat, 4)}]}}`,
  );
  kept += 1;
}

out.write('\n]}\n');
await new Promise((resolve) => out.end(resolve));

process.stdout.write('\r');
console.log(`read ${read.toLocaleString()} lakes`);
console.log(`${OUT} — ${kept.toLocaleString()} with area and elevation, ${(statSync(OUT).size / 1e6).toFixed(1)} MB`);

function round(n, places) {
  const f = 10 ** places;
  return Math.round(n * f) / f;
}
