#!/usr/bin/env node
/**
 * Cuts the Natural Earth files down to the part of the world this renders.
 *
 * The full 1:10m country set is 12.7 MB and the coastline 9.6 MB, nearly all of
 * it somewhere else on the planet. Keeping only the features that touch a
 * Europe bounding box drops both by well over an order of magnitude, which
 * matters because the page parses this before it can draw anything.
 *
 * Features are kept whole rather than clipped to the box. Clipping polygons
 * properly means handling ring winding and re-closing cut edges, and getting it
 * subtly wrong puts spurious coastline down the side of the picture - the
 * canvas already discards anything off-screen for free.
 */

import { existsSync, readFileSync, writeFileSync, statSync } from 'node:fs';

const CDN = 'https://raw.githubusercontent.com/nvkelso/natural-earth-vector/master/geojson';

/** Generous margin, so the view can move without re-running this. */
const BOX = { west: -25, east: 45, south: 30, north: 75 };

/**
 * A world coastline for use as a faint underlay, at 1:50m rather than 1:10m.
 *
 * Drawn a pixel wide behind data, the finer set is 9.6 MB of detail that is
 * invisible at any sensible zoom and just slows the page down.
 */
await download(`${CDN}/ne_50m_coastline.geojson`, 'data/world-coastline.geojson');
console.log(`data/world-coastline.geojson — ${(statSync('data/world-coastline.geojson').size / 1e6).toFixed(2)} MB`);

// Country polygons rather than the coastline alone: stroking them gives coasts
// and national borders in one pass, and a coastline file contains no borders.
await download(`${CDN}/ne_50m_admin_0_countries.geojson`, 'data/world-countries.geojson');
console.log(`data/world-countries.geojson — ${(statSync('data/world-countries.geojson').size / 1e6).toFixed(2)} MB`);

for (const [name, out] of [
  ['ne_10m_admin_0_countries', 'data/europe-countries.geojson'],
  ['ne_10m_coastline', 'data/europe-coastline.geojson'],
]) {
  const source = `data/${name}.geojson`;
  await download(`${CDN}/${name}.geojson`, source);

  const collection = JSON.parse(readFileSync(source, 'utf8'));

  const features = collection.features.filter((feature) => overlaps(feature.geometry));

  // Names and codes are the only properties worth keeping; the rest is a few
  // hundred kilobytes of population estimates and translated labels.
  for (const feature of features) {
    const { NAME, ISO_A2 } = feature.properties ?? {};
    feature.properties = NAME ? { name: NAME, iso: ISO_A2 } : {};
  }

  writeFileSync(out, JSON.stringify({ type: 'FeatureCollection', features }));
  console.log(
    `${out} — ${features.length}/${collection.features.length} features, ` +
      `${(statSync(out).size / 1e6).toFixed(2)} MB`,
  );
}

/** Natural Earth is public domain; the raw files are gitignored, not vendored. */
async function download(url, to) {
  if (existsSync(to)) return;
  console.log(`fetching ${url}`);
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} fetching ${url}`);
  writeFileSync(to, Buffer.from(await response.arrayBuffer()));
}

function overlaps(geometry) {
  if (!geometry) return false;
  let west = Infinity;
  let east = -Infinity;
  let south = Infinity;
  let north = -Infinity;

  walk(geometry.coordinates, ([lon, lat]) => {
    if (lon < west) west = lon;
    if (lon > east) east = lon;
    if (lat < south) south = lat;
    if (lat > north) north = lat;
  });

  return west <= BOX.east && east >= BOX.west && south <= BOX.north && north >= BOX.south;
}

/** GeoJSON nests coordinates to different depths per geometry type. */
function walk(node, visit) {
  if (typeof node[0] === 'number') {
    visit(node);
    return;
  }
  for (const child of node) walk(child, visit);
}
