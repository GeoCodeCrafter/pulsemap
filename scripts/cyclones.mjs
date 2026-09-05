#!/usr/bin/env node
/**
 * Builds a track network for every tropical cyclone since 1980, from IBTrACS.
 *
 * IBTrACS is one row per observation, so a storm is a run of rows sharing a
 * storm id. This emits one short LineString per consecutive pair rather than
 * one polyline per storm, which costs more features but means each piece of
 * track carries its own date - so the pulse travels *along* a storm as it
 * happened, instead of the whole track flashing at once.
 *
 * Two filters, both deliberate:
 *
 *   Since 1980, not the full archive back to 1842. Positions before routine
 *   satellite coverage come from ship reports and landfall accounts, so the
 *   older map shows shipping lanes and coastlines more than it shows storms.
 *
 *   Storms that reached at least 34 kt. Below that the record is dominated by
 *   how willing each agency was to log a weak disturbance, which varies by
 *   basin and by decade - the same instrumentation bias that sets the
 *   magnitude floor on the earthquake map.
 */

import { createReadStream, createWriteStream, existsSync, statSync } from 'node:fs';
import { createInterface } from 'node:readline';

const SOURCE = 'data/ibtracs.since1980.csv';
const OUT = 'data/cyclones.geojson';
const URL =
  'https://www.ncei.noaa.gov/data/international-best-track-archive-for-climate-stewardship-ibtracs/v04r01/access/csv/ibtracs.since1980.list.v04r01.csv';

/** Tropical storm strength. Anything weaker is inconsistently recorded. */
const MIN_PEAK_KT = 34;

if (!existsSync(SOURCE)) {
  console.log(`fetching IBTrACS since-1980 archive (137 MB)...`);
  const response = await fetch(URL);
  if (!response.ok) throw new Error(`${response.status} from NCEI`);
  const { Readable } = await import('node:stream');
  const { pipeline } = await import('node:stream/promises');
  await pipeline(Readable.fromWeb(response.body), createWriteStream(SOURCE));
  console.log(`  saved ${SOURCE}`);
}

const input = createInterface({ input: createReadStream(SOURCE), crlfDelay: Infinity });

let columns = null;
let lineNumber = 0;
const storms = new Map();

for await (const line of input) {
  lineNumber += 1;
  if (lineNumber === 1) {
    columns = Object.fromEntries(line.split(',').map((name, i) => [name.trim(), i]));
    continue;
  }
  // Row two is a units row, not data.
  if (lineNumber === 2) continue;

  const cells = line.split(',');
  const sid = cells[columns.SID];
  if (!sid) continue;

  const lat = Number(cells[columns.LAT]);
  const raw = Number(cells[columns.LON]);
  if (!Number.isFinite(lat) || !Number.isFinite(raw)) continue;

  // IBTrACS mixes longitude conventions between contributing agencies: most
  // report -180 to 180, some report 0 to 360, and the file runs to 266 as a
  // result. Left alone, every western Pacific storm is drawn off the right
  // edge of the map - and because nothing then sits near 180, the dateline
  // check finds no crossings to skip, which is what made the bug look fine.
  const lon = (((raw + 180) % 360) + 360) % 360 - 180;

  const time = cells[columns.ISO_TIME];
  const hour = Number(time?.slice(11, 13));
  // Synoptic hours only. IBTrACS interpolates to three-hourly, and the
  // in-between rows are filled rather than observed - dropping them halves the
  // feature count and loses nothing that was measured.
  if (![0, 6, 12, 18].includes(hour)) continue;

  // WMO_WIND is the official value but is blank for a lot of basins; USA_WIND
  // is the fallback the archive itself recommends for a complete series.
  const wind = num(cells[columns.WMO_WIND]) ?? num(cells[columns.USA_WIND]) ?? 0;

  let storm = storms.get(sid);
  if (!storm) {
    storm = { peak: 0, points: [] };
    storms.set(sid, storm);
  }
  if (wind > storm.peak) storm.peak = wind;
  storm.points.push({ lat, lon, wind, day: dayOfYear(time) });
}

const out = createWriteStream(OUT);
out.write('{"type":"FeatureCollection","features":[\n');

let kept = 0;
let dropped = 0;
let crossings = 0;

for (const storm of storms.values()) {
  if (storm.peak < MIN_PEAK_KT) {
    dropped += 1;
    continue;
  }

  for (let i = 1; i < storm.points.length; i++) {
    const a = storm.points[i - 1];
    const b = storm.points[i];

    // A storm crossing the dateline has consecutive longitudes near +180 and
    // -180. Drawn as-is that is a horizontal line straight back across the
    // entire map, and the Pacific ends up striped with them.
    if (Math.abs(a.lon - b.lon) > 180) {
      crossings += 1;
      continue;
    }

    const wind = Math.max(a.wind, b.wind);
    out.write(
      `${kept ? ',\n' : ''}{"type":"Feature","properties":{"w":${wind},"d":${b.day}},` +
        `"geometry":{"type":"LineString","coordinates":` +
        `[[${r(a.lon)},${r(a.lat)}],[${r(b.lon)},${r(b.lat)}]]}}`,
    );
    kept += 1;
  }
}

out.write('\n]}\n');
await new Promise((resolve) => out.end(resolve));

console.log(`${storms.size.toLocaleString()} storms, ${dropped.toLocaleString()} below ${MIN_PEAK_KT} kt`);
console.log(`${crossings} dateline crossings skipped`);
console.log(`${OUT} — ${kept.toLocaleString()} segments, ${(statSync(OUT).size / 1e6).toFixed(1)} MB`);

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) && value?.trim() !== '' ? n : null;
}

/** 1 to 366. The pulse sweeps this, so a loop is one calendar year. */
function dayOfYear(iso) {
  const date = new Date(`${iso.replace(' ', 'T')}Z`);
  if (Number.isNaN(date.getTime())) return 1;
  const start = Date.UTC(date.getUTCFullYear(), 0, 1);
  return Math.floor((date.getTime() - start) / 86_400_000) + 1;
}

function r(n) {
  return Math.round(n * 100) / 100;
}
