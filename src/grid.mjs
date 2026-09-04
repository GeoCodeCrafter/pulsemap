/**
 * The sampling grid.
 *
 * 1.5 degrees over Europe — about 780 points, eight requests.
 *
 * The limit is not resolution, it is quota. Open-Meteo counts every *location*
 * as an API call rather than every request, so a 100-coordinate batch costs 100
 * calls, and 0.75 degrees is 3,009 of them for one picture.
 *
 * I started at 1.5 to be a good citizen and the picture did not work: 30 x 26
 * samples stretched over a 780 x 1040 canvas is a blur with the sample grid
 * showing through it, and no coastline survives that even though the numbers
 * underneath say land disagrees nearly twice as much as sea. The resolution is
 * the whole artefact, so it gets the quota - spent once, at one request every
 * 11 seconds, and cached in data/ afterwards so a re-render costs nothing.
 */

export const BOUNDS = { south: 34, north: 72, west: -12, east: 32 };
export const STEP = 0.75;

export function buildGrid({ south, north, west, east } = BOUNDS, step = STEP) {
  const lats = [];
  const lons = [];

  for (let lat = north; lat >= south; lat -= step) lats.push(round(lat));
  for (let lon = west; lon <= east; lon += step) lons.push(round(lon));

  const points = [];
  for (let row = 0; row < lats.length; row++) {
    for (let col = 0; col < lons.length; col++) {
      points.push({ row, col, lat: lats[row], lon: lons[col] });
    }
  }

  return { lats, lons, points, width: lons.length, height: lats.length };
}

const round = (n) => Math.round(n * 1000) / 1000;
