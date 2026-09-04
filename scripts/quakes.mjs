#!/usr/bin/env node
/**
 * Pulls a global earthquake catalogue from the USGS.
 *
 * Same idea as the rivers: draw only the events and let the geography appear.
 * Nothing here plots a coastline or a plate boundary - the boundaries show up
 * because that is where earthquakes happen, and the Pacific rim draws itself.
 *
 * Magnitude 4.5 and up. Below that the catalogue is dominated by how densely
 * a region is instrumented rather than by how much it actually shakes, so the
 * map would end up showing where the seismometers are - California and Japan
 * blazing, the mid-Atlantic ridge missing. 4.5 is roughly the level at which
 * global detection is complete and every event is in the record wherever it
 * happened.
 */

import { writeFileSync } from 'node:fs';

const ENDPOINT = 'https://earthquake.usgs.gov/fdsnws/event/1/query';
const OUT = 'data/quakes.geojson';

/**
 * Fetched a year at a time.
 *
 * The endpoint caps a single response at 20,000 events and, more awkwardly,
 * silently defaults to the last thirty days when no start date is given - my
 * first run looked like it worked and returned 633 events. Year windows stay
 * well under the cap and make the date range explicit.
 */
const FROM = 2019;
const TO = new Date().getUTCFullYear();
const MIN_MAG = 4.5;

const features = [];
for (let year = FROM; year <= TO; year++) {
  const url =
    `${ENDPOINT}?format=geojson&minmagnitude=${MIN_MAG}&orderby=time` +
    `&starttime=${year}-01-01&endtime=${year + 1}-01-01&limit=20000`;

  const response = await fetch(url);
  if (!response.ok) throw new Error(`${response.status} from USGS for ${year}`);
  const chunk = await response.json();
  features.push(...chunk.features);
  console.log(`  ${year}: ${chunk.features.length} events`);
}

const events = features
  .map((f) => {
    const [lon, lat, depth] = f.geometry?.coordinates ?? [];
    return {
      lon: round(lon, 3),
      lat: round(lat, 3),
      // Depth comes back in km and is occasionally null offshore.
      z: round(depth ?? 10, 1),
      m: round(f.properties?.mag ?? 0, 2),
      t: f.properties?.time ?? 0,
    };
  })
  .filter((e) => Number.isFinite(e.lon) && Number.isFinite(e.lat) && e.t > 0)
  .sort((a, b) => a.t - b.t);

// Written as GeoJSON like everything else, so the renderer has one loader
// rather than a special case per dataset.
const geojson = {
  type: 'FeatureCollection',
  features: events.map((e) => ({
    type: 'Feature',
    properties: { m: e.m, z: e.z, t: e.t },
    geometry: { type: 'Point', coordinates: [e.lon, e.lat] },
  })),
};

const span = {
  from: new Date(events[0].t).toISOString().slice(0, 10),
  to: new Date(events.at(-1).t).toISOString().slice(0, 10),
};

writeFileSync(OUT, JSON.stringify(geojson));

const depths = events.map((e) => e.z).sort((a, b) => a - b);
console.log(`${OUT} — ${events.length.toLocaleString()} events, ${span.from} to ${span.to}`);
console.log(
  `magnitude ${Math.min(...events.map((e) => e.m))} to ${Math.max(...events.map((e) => e.m))}, ` +
    `depth median ${depths[depths.length >> 1]} km, max ${depths.at(-1)} km`,
);

function round(n, places) {
  const f = 10 ** places;
  return typeof n === 'number' ? Math.round(n * f) / f : n;
}
