#!/usr/bin/env node
/**
 * Pulls the river network for Britain and Ireland out of HydroRIVERS.
 *
 * The Europe shapefile is 252 MB unpacked and covers everything from Iceland to
 * the Urals. This keeps the segments inside a box round these islands, drops
 * every attribute except the four the renderer uses, and rounds coordinates to
 * five decimal places - about a metre, which is far finer than anything drawn
 * at 4K and cuts the file roughly in half on its own.
 *
 * Attributes kept:
 *   ORD_STRA    Strahler order. 1 is a headwater trickle, 8 or 9 is a trunk
 *               river. This drives line weight, so the network thickens
 *               downstream the way a real drainage basin looks.
 *   DIS_AV_CMS  Long term average discharge, cubic metres per second.
 *   MAIN_RIV    Id of the trunk river each segment eventually drains into -
 *               the catchment, which is what makes basins separable by colour.
 *   DIST_DN_KM  Distance along the channel to where this river reaches the
 *               sea. This is what makes flow animatable without simulating
 *               anything: a pulse is just a band in distance-to-sea, and
 *               sweeping that band seaward lights every segment in the right
 *               order, across every basin at once, for free.
 *   HYRIV_ID / NEXT_DOWN  Topology, kept for anything that needs the graph.
 */

import { createWriteStream, existsSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { open } from 'shapefile';

/**
 * Region presets. Add one and it is renderable, given a matching config.
 *
 * `minOrder` exists because area and segment count grow together fast. Britain
 * at every order is 28,500 segments and 6.8 MB; the same treatment of Europe is
 * several hundred thousand and well over a hundred megabytes, which is neither
 * committable nor drawable at a sensible frame rate. Dropping order 1 there
 * loses the smallest headwater threads - invisible at that zoom anyway - and
 * roughly halves the file.
 */
const REGIONS = {
  britain: {
    box: { west: -11.2, east: 2.2, south: 49.7, north: 61.2 },
    minOrder: 1,
  },
  europe: {
    box: { west: -10.5, east: 31.5, south: 36.0, north: 62.0 },
    minOrder: 3,
  },
};

const region = process.argv[2] ?? 'britain';
if (!REGIONS[region]) {
  console.log(`unknown region "${region}" - try: ${Object.keys(REGIONS).join(', ')}`);
  process.exit(1);
}

const { box: BOX, minOrder: MIN_ORDER } = REGIONS[region];

const SOURCE = 'data/HydroRIVERS_v10_eu_shp/HydroRIVERS_v10_eu.shp';
const OUT = `data/rivers-${region}.geojson`;

if (!existsSync(SOURCE)) {
  console.log(`missing ${SOURCE}`);
  console.log('download HydroRIVERS_v10_eu_shp.zip from data.hydrosheds.org and unzip it into data/');
  process.exit(1);
}

await mkdir('data', { recursive: true });

const out = createWriteStream(OUT);
out.write('{"type":"FeatureCollection","features":[\n');

const source = await open(SOURCE, undefined, { encoding: 'utf8' });

let read = 0;
let kept = 0;
let maxOrder = 0;

for (let result = await source.read(); !result.done; result = await source.read()) {
  read += 1;
  if (read % 100_000 === 0) process.stdout.write(`\r  read ${read.toLocaleString()}`);

  const feature = result.value;
  const coordinates = feature?.geometry?.coordinates;
  if (!coordinates?.length) continue;

  // Bounding box test on the segment itself. Segments are short - a kilometre
  // or two - so testing the first vertex would drop pieces that cross the edge
  // of the box and leave the coastline visibly nibbled.
  if (!intersects(coordinates)) continue;

  const p = feature.properties ?? {};
  const order = p.ORD_STRA ?? 1;
  if (order < MIN_ORDER) continue;
  if (order > maxOrder) maxOrder = order;

  const line = coordinates.map(([lon, lat]) => [round(lon), round(lat)]);

  out.write(
    `${kept ? ',\n' : ''}{"type":"Feature","properties":{"o":${order},` +
      `"d":${Number((p.DIS_AV_CMS ?? 0).toFixed(3))},"m":${p.MAIN_RIV ?? 0},` +
      `"k":${Number((p.DIST_DN_KM ?? 0).toFixed(1))},` +
      `"i":${p.HYRIV_ID ?? 0},"n":${p.NEXT_DOWN ?? 0}},` +
      `"geometry":{"type":"LineString","coordinates":${JSON.stringify(line)}}}`,
  );
  kept += 1;
}

out.write('\n]}\n');
await new Promise((resolve) => out.end(resolve));

process.stdout.write('\r');
console.log(`read ${read.toLocaleString()} segments across Europe`);
console.log(`${OUT} — ${kept.toLocaleString()} segments, Strahler order up to ${maxOrder}`);

function intersects(coordinates) {
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;

  for (const [lon, lat] of coordinates) {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  }

  return west <= BOX.east && east >= BOX.west && south <= BOX.north && north >= BOX.south;
}

function round(n) {
  return Math.round(n * 1e5) / 1e5;
}
