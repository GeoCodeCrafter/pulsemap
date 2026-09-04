#!/usr/bin/env node
/**
 * Fetches a grid of ensemble forecasts and reduces each point to a spread per
 * lead day.
 *
 * Daily variables rather than hourly on purpose: 40 members x 7 days per point
 * is a few hundred bytes, where the hourly equivalent is 40 x 168 and the whole
 * grid would be tens of megabytes of data thrown away immediately.
 *
 * The pace is the important part. Open-Meteo counts every *location* as an API
 * call rather than every request, so a 100-coordinate batch costs 100 calls
 * against a budget of roughly 600 a minute. The first version of this went out
 * twenty times too fast, had 2,300 of 3,009 points rejected, and left the whole
 * IP locked out for the rest of the day.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { BOUNDS, STEP, buildGrid } from '../src/grid.mjs';
import { spreadOf } from '../src/spread.mjs';

const ENDPOINT = 'https://ensemble-api.open-meteo.com/v1/ensemble';
const MODEL = 'icon_seamless';
const VARIABLE = 'temperature_2m_max';
const DAYS = 7;
const BATCH = 100;
/**
 * 100 locations per request against ~600/minute is one request every 11s, and
 * at that pace a 780-point grid goes through clean. Over a full 3,009-point run
 * it does not: sustained 11s pacing had 1,209 points rejected, because the
 * limit is a rolling budget rather than a per-second rate and a long run drains
 * it. 16s is slower than it needs to be for a short run and is the difference
 * between a complete grid and a holed one for a long one.
 */
const PAUSE_MS = 16_000;

/**
 * Stamped once at the start rather than at each save, because every date label
 * on the render is this plus a lead day.
 */
const RUN_STARTED = new Date();

const grid = buildGrid();
console.log(`grid: ${grid.width} x ${grid.height} = ${grid.points.length} points`);

await waitForQuota();

/**
 * spread[day][row][col], plus elevation for a land mask if it's ever wanted.
 *
 * Resumed from disk when a previous run left something behind. An earlier
 * attempt got 600 of 780 points in before the machine was restarted under it
 * and wrote nothing at all, because the file was only saved at the very end.
 * Now every batch is saved as it lands and an interrupted run costs 11 seconds
 * rather than the whole thing.
 */
const cached = loadCache();
const spread =
  cached?.spread ??
  Array.from({ length: DAYS }, () =>
    Array.from({ length: grid.height }, () => new Array(grid.width).fill(null)),
  );
const elevation =
  cached?.elevation ?? Array.from({ length: grid.height }, () => new Array(grid.width).fill(null));

let done = 0;
let failed = 0;

for (let i = 0; i < grid.points.length; i += BATCH) {
  const batch = grid.points.slice(i, i + BATCH);
  const url =
    `${ENDPOINT}?latitude=${batch.map((p) => p.lat).join(',')}` +
    `&longitude=${batch.map((p) => p.lon).join(',')}` +
    `&models=${MODEL}&daily=${VARIABLE}&forecast_days=${DAYS}&timezone=UTC`;

  // Skip a batch that a previous run already filled in.
  if (batch.every((p) => spread[0][p.row][p.col] !== null)) {
    done += batch.length;
    console.log(`  ${done + failed}/${grid.points.length} points (cached)`);
    continue;
  }

  const locations = await withRetry(url);

  if (!locations) {
    failed += batch.length;
  } else {
    batch.forEach((point, index) => {
      const location = locations[index];
      if (!location?.daily) return;

      elevation[point.row][point.col] = location.elevation ?? null;

      const keys = Object.keys(location.daily).filter((k) => k.startsWith(VARIABLE));
      for (let day = 0; day < DAYS; day++) {
        spread[day][point.row][point.col] = round(spreadOf(keys.map((k) => location.daily[k][day])));
      }
    });
    done += batch.length;
  }

  console.log(`  ${done + failed}/${grid.points.length} points (${failed} failed)`);
  save();
  if (i + BATCH < grid.points.length) await sleep(PAUSE_MS);
}

save();

const flat = spread.flat(2).filter((v) => v !== null);
const coverage = ((flat.length / (DAYS * grid.points.length)) * 100).toFixed(0);
console.log(
  `data/spread.json - ${coverage}% coverage, ` +
    `range ${Math.min(...flat).toFixed(1)} to ${Math.max(...flat).toFixed(1)} degrees`,
);

function save() {
  mkdirSync('data', { recursive: true });
  writeFileSync(
    'data/spread.json',
    JSON.stringify({
      generated: RUN_STARTED.toISOString(),
      model: MODEL,
      variable: VARIABLE,
      bounds: BOUNDS,
      step: STEP,
      width: grid.width,
      height: grid.height,
      days: DAYS,
      spread,
      elevation,
    }),
  );
}

/**
 * Only reuses a cache from the same grid *and* the same forecast run.
 *
 * The geometry check alone is not enough and I nearly shipped that. A run got
 * 60% of the grid before the daily quota ran out, and resuming the next morning
 * would have filled the missing northern third from a forecast initialised a
 * day later than the rest. Every number would have been individually correct
 * and the map would have been a lie - two different atmospheres stitched
 * together at a horizontal seam, with one `generated` date printed under it.
 *
 * A partial grid from an older run is worth nothing, so it gets thrown away and
 * refetched whole.
 */
function loadCache() {
  if (!existsSync('data/spread.json')) return null;
  try {
    const previous = JSON.parse(readFileSync('data/spread.json', 'utf8'));
    if (previous.width !== grid.width || previous.height !== grid.height) return null;
    if (previous.step !== STEP || previous.days !== DAYS) return null;

    const sameRun = previous.generated?.slice(0, 10) === RUN_STARTED.toISOString().slice(0, 10);
    if (!sameRun) {
      console.log(`  ignoring cache from ${previous.generated?.slice(0, 10)} - different forecast run`);
      return null;
    }

    console.log('  resuming from the previous run');
    return previous;
  } catch {
    return null;
  }
}

/**
 * Sits out an existing rate limit before starting anything.
 *
 * Going in hard while already limited just extends the ban, and a run that
 * fills a quarter of the grid is worse than no run at all.
 */
async function waitForQuota() {
  const probe =
    `${ENDPOINT}?latitude=51.5&longitude=-0.1&models=${MODEL}` +
    `&daily=${VARIABLE}&forecast_days=1&timezone=UTC`;

  for (let attempt = 0; attempt < 40; attempt++) {
    const response = await fetch(probe).catch(() => null);
    if (response?.ok) {
      if (attempt > 0) console.log('  quota available again');
      return;
    }
    console.log(`  rate limited (${response?.status ?? 'network'}), waited ${attempt + 1} min`);
    await sleep(60_000);
  }

  console.log('  still limited after 40 minutes - the daily quota is probably gone, try tomorrow');
  process.exit(1);
}

/** Backs off rather than giving up: a partial grid is not worth keeping. */
async function withRetry(url) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const response = await fetch(url).catch(() => null);
    if (response?.ok) return response.json();

    const wait = response?.status === 429 ? 45_000 * (attempt + 1) : 3_000;
    console.log(`    ${response?.status ?? 'network error'}, retrying in ${wait / 1000}s`);
    await sleep(wait);
  }
  return null;
}

function round(n) {
  return n === null ? null : Math.round(n * 100) / 100;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
