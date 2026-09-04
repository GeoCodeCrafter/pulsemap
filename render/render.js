/**
 * Draws the spread field.
 *
 * No basemap, no coastline, no borders. Every pixel is forecast disagreement
 * and nothing else. The continent shows up because the sea is thermally
 * sluggish and the land isn't: by day seven the mean spread over land is 2.5
 * times the mean over water, where on day one the two are within 8% and there
 * is nothing to see. If a coastline appears, the data drew it.
 */

/**
 * The window onto the data, which is not always all of it.
 *
 * A run that only half completed still covered 39.75N to 54.75N across the full
 * width, and that band happens to hold everything the picture is about - the
 * Alps, the Pannonian basin, the Bay of Biscay, the Adriatic and the northern
 * Mediterranean. Cropping to a complete region beats rendering the whole box
 * with holes in it.
 */
const VIEW = { north: 54.75, south: 39.75, west: -12, east: 32 };

const WIDTH = 1240;

/**
 * Whether to smooth between samples.
 *
 * There are 59 x 21 real measurements behind this image and it is drawn 1240
 * pixels wide, so smoothing is a 21x upscale and it looks exactly like one -
 * every viewer reads soft edges at this scale as a low quality photograph
 * rather than as a coarse measurement, which is the wrong thing to communicate.
 * Drawing each sample as the rectangle it actually covers is honest about the
 * resolution and, being sharp, reads as deliberate.
 */
const SMOOTH = false;

/**
 * Height follows from the view, so the aspect ratio is never wrong by hand.
 *
 * Longitude lines converge, so a degree of longitude at 47N is only cos(47) of
 * a degree of latitude. Without the correction Europe comes out stretched
 * sideways by a third.
 */
const HEIGHT = Math.round(
  (WIDTH * (VIEW.north - VIEW.south)) /
    ((VIEW.east - VIEW.west) * Math.cos((((VIEW.north + VIEW.south) / 2) * Math.PI) / 180)),
);

/**
 * Fixed across every frame, deliberately.
 *
 * Rescaling per day would normalise away the entire point: day one would look
 * as dramatic as day seven. The whole claim is that the number gets bigger.
 */
/** Change this to a short domain once there is one - see the README. */
const WATERMARK = 'github.com/GeoCodeCrafter/unsettled';

const SCALE_MIN = 0.5;
const SCALE_MAX = 16;

/**
 * The scale is deliberately not linear.
 *
 * Spread is heavily skewed: the median cell is 1.2 degrees on day one and 3.0
 * on day seven, while the worst mountain cells run past 15. On a linear ramp
 * that puts almost every pixel in the bottom third of the colours on almost
 * every frame, and the map reads as a dark smudge that gets slightly less dark.
 * A gamma opens up the low end where the data actually lives, at the cost of a
 * colour bar with uneven ticks - which is why the bar below is drawn with real
 * degree markings rather than a tidy linear one.
 *
 * The top of the scale is set by the maximum in the data rather than by where
 * the interesting values are. Capping at 10 looked like a good idea and wasn't:
 * everything above about 9 degrees lands on the near-white end of the ramp, and
 * because the extremes are spatially clustered rather than scattered that came
 * out as one blown highlight over Hungary with no structure inside it. Reading
 * as an overexposed photograph is worse than reading as nothing.
 */
const GAMMA = 0.7;

/** Deep indigo where the models agree, through to hot white where they don't. */
const RAMP = [
  [0.0, [6, 8, 16]],
  [0.16, [16, 28, 62]],
  [0.34, [22, 66, 118]],
  [0.52, [26, 122, 140]],
  [0.68, [96, 168, 118]],
  [0.82, [214, 176, 78]],
  [0.93, [240, 132, 62]],
  [1.0, [252, 244, 226]],
];

const data = await (await fetch('../data/spread.json')).json();
const canvas = document.getElementById('map');
canvas.width = WIDTH;
canvas.height = HEIGHT;
const ctx = canvas.getContext('2d');

window.unsettled = {
  days: data.days,
  size: { width: WIDTH, height: HEIGHT },
  draw,
  meta: () => ({ generated: data.generated, model: data.model, step: data.step }),
};

draw(6);

/**
 * @param {number} day
 * @param {number} coast 0 hides the outline, 1 draws it fully.
 */
function draw(day, coast = 0) {
  const field = data.spread[day];
  const image = ctx.createImageData(WIDTH, HEIGHT);

  // Equirectangular with a cosine correction at the middle latitude, so Europe
  // isn't stretched into a letterbox. Not a projection anyone would defend for
  // measurement, but this is a picture.
  for (let y = 0; y < HEIGHT; y++) {
    const lat = VIEW.north - (y / (HEIGHT - 1)) * (VIEW.north - VIEW.south);
    // Indices are always relative to the data's own origin, not the view's.
    const row = (data.bounds.north - lat) / data.step;

    for (let x = 0; x < WIDTH; x++) {
      const lon = VIEW.west + (x / (WIDTH - 1)) * (VIEW.east - VIEW.west);
      const col = (lon - data.bounds.west) / data.step;

      const value = SMOOTH
        ? sample(field, row, col)
        : (field[Math.round(row)]?.[Math.round(col)] ?? null);
      const index = (y * WIDTH + x) * 4;

      if (value === null) {
        image.data[index] = 6;
        image.data[index + 1] = 8;
        image.data[index + 2] = 16;
        image.data[index + 3] = 255;
        continue;
      }

      const [r, g, b] = rampAt(normalise(value));
      image.data[index] = r;
      image.data[index + 1] = g;
      image.data[index + 2] = b;
      image.data[index + 3] = 255;
    }
  }

  if (coast > 0) drawCoast(image, coast);

  ctx.putImageData(image, 0, 0);
  annotate(day);
}

/**
 * The coastline, drawn from the elevation the API returns for each grid point.
 *
 * This is the honest way to check the claim the picture makes. The outline is
 * not a basemap and not a shapefile - it is the 0 m contour of the *same* 59x21
 * samples the colours come from, so the two are drawn at identical resolution
 * from one request. If the bright and dark regions line up with it, the spread
 * field really did find the coast on its own; if they did not, no amount of
 * arguing in a caption would save it.
 *
 * Marking the boundary of a bilinear land mask gives a one-pixel line for free,
 * which is all this needs.
 */
function drawCoast(image, alpha) {
  // Interpolate land-ness, not height. Smoothing raw elevation and cutting at
  // half a metre puts the contour hard up against each sea cell, because land
  // samples are hundreds of metres and the crossing happens almost immediately
  // - so it draws the sample grid as a staircase rather than a coast. Reducing
  // to 0 or 1 first and cutting at 0.5 puts the line midway between samples,
  // which is where a coast between a wet point and a dry one actually is.
  const binary = data.elevation.map((row) =>
    row.map((e) => (e === null ? null : e > 0.5 ? 1 : 0)),
  );

  const land = new Uint8Array(WIDTH * HEIGHT);

  for (let y = 0; y < HEIGHT; y++) {
    const lat = VIEW.north - (y / (HEIGHT - 1)) * (VIEW.north - VIEW.south);
    const row = (data.bounds.north - lat) / data.step;
    for (let x = 0; x < WIDTH; x++) {
      const lon = VIEW.west + (x / (WIDTH - 1)) * (VIEW.east - VIEW.west);
      const value = sample(binary, row, (lon - data.bounds.west) / data.step);
      land[y * WIDTH + x] = value !== null && value > 0.5 ? 1 : 0;
    }
  }

  for (let y = 1; y < HEIGHT - 1; y++) {
    for (let x = 1; x < WIDTH - 1; x++) {
      const at = y * WIDTH + x;
      const edge =
        land[at] !== land[at + 1] ||
        land[at] !== land[at - 1] ||
        land[at] !== land[at + WIDTH] ||
        land[at] !== land[at - WIDTH];
      if (!edge) continue;

      const index = at * 4;
      for (let c = 0; c < 3; c++) {
        const target = [226, 232, 240][c];
        image.data[index + c] = Math.round(image.data[index + c] * (1 - alpha) + target * alpha);
      }
    }
  }
}

/** Bilinear, skipping missing corners rather than treating them as zero. */
function sample(field, row, col) {
  const r0 = Math.floor(row);
  const c0 = Math.floor(col);
  const fr = row - r0;
  const fc = col - c0;

  let total = 0;
  let weight = 0;

  for (const [dr, dc, w] of [
    [0, 0, (1 - fr) * (1 - fc)],
    [0, 1, (1 - fr) * fc],
    [1, 0, fr * (1 - fc)],
    [1, 1, fr * fc],
  ]) {
    const value = field[r0 + dr]?.[c0 + dc];
    if (typeof value === 'number') {
      total += value * w;
      weight += w;
    }
  }

  return weight > 0.05 ? total / weight : null;
}

/** Degrees to a 0-1 ramp position. */
function normalise(value) {
  return clamp01((value - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) ** GAMMA;
}

function rampAt(t) {
  for (let i = 1; i < RAMP.length; i++) {
    if (t <= RAMP[i][0]) {
      const [t0, c0] = RAMP[i - 1];
      const [t1, c1] = RAMP[i];
      const k = (t - t0) / (t1 - t0);
      return [0, 1, 2].map((n) => Math.round(c0[n] + k * (c1[n] - c0[n])));
    }
  }
  return RAMP[RAMP.length - 1][1];
}

/**
 * Everything the image needs to stand on its own, and nothing else.
 * Somebody scrolling past has to be able to tell what they are looking at
 * without a caption, because the caption is a different website by then.
 */
function annotate(day) {
  const date = new Date(data.generated);
  date.setUTCDate(date.getUTCDate() + day);

  ctx.textBaseline = 'top';

  // Colour bar.
  const barX = 30;
  const barY = 34;
  const barW = 220;
  const barH = 10;

  // Drawn through the same gamma as the map, so a colour on the bar is the
  // colour that value gets on the map.
  for (let i = 0; i < barW; i++) {
    const degrees = SCALE_MIN + (i / (barW - 1)) * (SCALE_MAX - SCALE_MIN);
    const [r, g, b] = rampAt(normalise(degrees));
    ctx.fillStyle = `rgb(${r},${g},${b})`;
    ctx.fillRect(barX + i, barY, 1, barH);
  }

  // Ticks at real degree values rather than at even pixel spacing - the whole
  // reason for labelling it at all is so the colours mean something.
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  ctx.textAlign = 'center';
  for (const degrees of [1, 2, 4, 8, 16]) {
    const x = barX + ((degrees - SCALE_MIN) / (SCALE_MAX - SCALE_MIN)) * (barW - 1);
    ctx.fillStyle = '#4a5262';
    ctx.fillRect(Math.round(x), barY + barH, 1, 4);
    ctx.fillStyle = '#8d97a8';
    ctx.fillText(String(degrees), x, barY + barH + 6);
  }
  ctx.textAlign = 'left';

  ctx.fillStyle = '#8d97a8';
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillText('spread between forecasts, °C', barX, barY + barH + 22);

  // Which day this frame is.
  ctx.fillStyle = '#e8ecf3';
  ctx.font = '600 22px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillText(`${day + 1} day${day === 0 ? '' : 's'} ahead`, barX, barY + barH + 46);

  ctx.fillStyle = '#8d97a8';
  ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillText(
    date.toUTCString().slice(5, 16),
    barX,
    barY + barH + 76,
  );

  // Provenance, small, bottom left.
  ctx.fillStyle = '#6d7789';
  ctx.font = '11px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillText(
    'ICON ensemble · 40 members · daily maximum 2 m air temperature',
    barX,
    HEIGHT - 44,
  );
  ctx.fillText(`p90 - p10 of the members, ${data.step} degree grid`, barX, HEIGHT - 28);

  // The only attribution on the image.
  //
  // r/MapPorn and most of the picture subreddits ban advertising outright, so a
  // link in the title or the comments gets the post removed. A small mark that
  // someone can type into a browser is the whole strategy - anyone who wants to
  // know where it came from will look, and nobody else is bothered by it.
  ctx.textAlign = 'right';
  ctx.fillStyle = '#5d6675';
  ctx.font = '12px ui-monospace, Menlo, Consolas, monospace';
  ctx.fillText(WATERMARK, WIDTH - 30, HEIGHT - 28);
  ctx.textAlign = 'left';
}

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}
