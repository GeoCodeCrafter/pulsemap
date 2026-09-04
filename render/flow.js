/**
 * Wind drawn as particles, coloured by temperature, masked to land.
 *
 * The texture is the point. A scalar field interpolated up to screen size looks
 * like a blurry photograph however good the data is, because smoothing between
 * samples is literally an upscale. Advecting particles through the vector field
 * instead produces detail at pixel scale from a coarse grid, because the detail
 * comes from the motion rather than from the sampling.
 *
 * Land comes from Natural Earth 1:10m country polygons, not from the weather
 * data. The first version derived a coastline from the elevation the forecast
 * API returns per grid point, and at 0.75 degrees - roughly 80 km a cell - it
 * stair-stepped badly, lost anything smaller than a cell, and could not draw a
 * national border at all, because that information simply is not in a weather
 * response. Vector geometry is exact at any zoom and independent of whatever
 * the forecast grid happens to be.
 *
 * The wind here is synthetic - this file exists to settle the look before any
 * API quota is spent on it. Swap `fieldAt` for real u/v/temperature and nothing
 * else changes.
 */

const VIEW = { north: 54.75, south: 39.75, west: -12, east: 32 };

/** 4K wide. Everything below scales off this rather than being hand-tuned. */
const WIDTH = 3840;

/**
 * Rounded to an even number, because H.264 with 4:2:0 chroma cannot encode an
 * odd dimension - the aspect ratio maths landed on 623 and x264 rejected every
 * frame with a bare "invalid argument".
 */
const HEIGHT =
  2 *
  Math.round(
    (WIDTH * (VIEW.north - VIEW.south)) /
      ((VIEW.east - VIEW.west) * Math.cos((((VIEW.north + VIEW.south) / 2) * Math.PI) / 180)) /
      2,
  );

/**
 * The look was tuned at 1240 wide, so every length and count is expressed
 * relative to that and scaled up.
 *
 * The count is not simply area-scaled, which is the mistake I made first. Ink
 * on the canvas goes as count x stroke length x stroke width, and length and
 * width are both already linear in SCALE - so scaling the count by area on top
 * of that put roughly eight times too much ink down and 4K came out a blown
 * white sheet. Dividing the area back out by the per-stroke growth keeps the
 * covered fraction of the canvas constant at any resolution.
 */
const BASE_WIDTH = 1240;
const SCALE = WIDTH / BASE_WIDTH;
const STROKE_WIDTH = Math.max(1, 0.85 * SCALE);

/** Enough strokes to read as texture rather than as countable dots. */
const PARTICLES = Math.round((11500 * SCALE * SCALE) / (SCALE * STROKE_WIDTH));

/**
 * Tuned for 60fps playback rather than for a still.
 *
 * At 60 frames a second each step is a sixtieth of a second of motion, so the
 * per-step distance has to be small or the strokes strobe - but small steps
 * with a fast fade leave nothing on screen. Long lifetime, gentle fade and a
 * short step give continuous motion that still holds a visible tail.
 */
const LIFETIME = 132;

/**
 * How fast old trails are eaten away. Lower leaves longer smears.
 *
 * Additive blending accumulates, so too slow a fade with too many particles
 * fills every gap and the image goes from streamlines to soup - the individual
 * strokes are the thing worth looking at, and they need black around them.
 */
const FADE = 0.047;
/**
 * Deliberately slower than looks right in a still.
 *
 * Fast strokes read as busy and the eye has nothing to settle on. Halving the
 * step and lengthening the lifetime to match keeps every trail the same length
 * on screen while taking twice as long to draw it, which is what holds
 * attention rather than just filling the frame.
 */
const SPEED = 0.58 * SCALE;

/**
 * How much of its brightness a stroke keeps once it is off land.
 *
 * The field is drawn everywhere rather than clipped to the coast. Cutting it at
 * the boundary - even with a few pixels of overshoot - leaves every stroke
 * ending flat against the outline, and throws away the fact that the weather
 * does not stop at the shore. Drawing the whole field and dropping the sea to a
 * fraction of its brightness keeps the continent as the subject while the
 * surrounding flow still reads, and the coastline emerges from the contrast
 * rather than from a hard edge.
 */
const SEA_ALPHA = 0.15;

const TEMP_MIN = 2;
const TEMP_MAX = 30;

/** Change this to a short domain once there is one. */
const WATERMARK = 'github.com/GeoCodeCrafter/unsettled';

/**
 * Says plainly that the field is not real yet.
 *
 * An unlabelled picture of invented weather is the one genuinely bad outcome
 * here - it is indistinguishable from the real thing at a glance, and someone
 * would eventually ask which day it was.
 */
const SOURCE_LINE = 'synthetic wind field · technique preview, not a forecast';

/**
 * Cold blue through cyan to hot orange, matching the temperature bar.
 *
 * Saturated deliberately. The first version ran through a pale grey midpoint,
 * which is the safe cartographic choice and looked washed out once additive
 * blending had lifted everything toward white anyway - keeping real hue at the
 * middle of the scale is what stops the busiest parts of the frame turning into
 * a grey mass. Per-stroke alpha comes down slightly to compensate, so dense
 * areas saturate in colour rather than blowing out to white.
 */
const RAMP = [
  [0.0, [22, 58, 232]],
  [0.24, [0, 142, 255]],
  [0.44, [64, 214, 236]],
  [0.6, [150, 236, 190]],
  [0.74, [255, 206, 92]],
  [0.88, [255, 138, 44]],
  [1.0, [255, 78, 62]],
];

const countries = await (await fetch('../data/europe-countries.geojson')).json();

const canvas = document.getElementById('map');
canvas.width = WIDTH;
canvas.height = HEIGHT;
const ctx = canvas.getContext('2d');

const paths = buildPaths();
const land = buildLandMask();
const borders = buildBorderLayer();
const annotation = buildAnnotationLayer();

const particles = Array.from({ length: PARTICLES }, () => spawn());

let clock = 0;

reset();

window.flow = {
  size: { width: WIDTH, height: HEIGHT },
  step,
  run,
  reset,
};

/** Wipes to black and clears every trail. */
function reset() {
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = '#05070b';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);
  for (const p of particles) Object.assign(p, spawn());
}

/** Advances the simulation by `n` steps without drawing anything in between. */
function run(n) {
  for (let i = 0; i < n; i++) step();
}

function step() {
  clock += 1;

  // Fade rather than clear, so each particle leaves a tail behind it.
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = `rgba(5, 7, 11, ${FADE})`;
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Additive keeps crossing trails bright instead of muddy.
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineWidth = STROKE_WIDTH;
  ctx.lineCap = 'round';

  for (const p of particles) {
    const { u, v, temperature } = fieldAt(p.x, p.y);

    const nx = p.x + u * SPEED;
    const ny = p.y - v * SPEED;

    if (p.age++ > LIFETIME || nx < 0 || ny < 0 || nx >= WIDTH || ny >= HEIGHT) {
      Object.assign(p, spawn());
      continue;
    }

    const [r, g, b] = rampAt(clamp01((temperature - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)));
    // Fade in and out over the life of the stroke so trails have soft ends
    // rather than starting and stopping abruptly.
    const alpha =
      0.52 * Math.sin((p.age / LIFETIME) * Math.PI) * (onLand(nx, ny) ? 1 : SEA_ALPHA);

    ctx.strokeStyle = `rgba(${r},${g},${b},${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.moveTo(p.x, p.y);
    ctx.lineTo(nx, ny);
    ctx.stroke();

    p.x = nx;
    p.y = ny;
  }

  // Borders go on top of the trails, from a layer rasterised once. Stroking
  // 75 countries of 1:10m geometry every frame is far too slow at 4K; one
  // drawImage is not.
  ctx.globalCompositeOperation = 'source-over';
  ctx.drawImage(borders, 0, 0);
  ctx.drawImage(annotation, 0, 0);
}

/** Anywhere on the canvas - the field covers water as well as land. */
function spawn() {
  return {
    x: Math.random() * WIDTH,
    y: Math.random() * HEIGHT,
    age: Math.floor(Math.random() * LIFETIME),
  };
}

function onLand(x, y) {
  if (x < 0 || y < 0 || x >= WIDTH || y >= HEIGHT) return false;
  return land[(y | 0) * WIDTH + (x | 0)] === 1;
}

/** Equirectangular, matching the aspect correction applied to HEIGHT. */
function project(lon, lat) {
  return [
    ((lon - VIEW.west) / (VIEW.east - VIEW.west)) * (WIDTH - 1),
    ((VIEW.north - lat) / (VIEW.north - VIEW.south)) * (HEIGHT - 1),
  ];
}

/**
 * One Path2D per country.
 *
 * Every ring of a polygon goes into the same path so that `evenodd` filling
 * cuts the holes out - otherwise any lake big enough to appear at 1:10m fills
 * in as land and grows streamlines across the water.
 */
function buildPaths() {
  const built = [];

  for (const feature of countries.features) {
    const geometry = feature.geometry;
    if (!geometry) continue;

    const polygons =
      geometry.type === 'Polygon'
        ? [geometry.coordinates]
        : geometry.type === 'MultiPolygon'
          ? geometry.coordinates
          : [];

    const path = new Path2D();
    for (const rings of polygons) {
      for (const ring of rings) {
        ring.forEach(([lon, lat], index) => {
          const [x, y] = project(lon, lat);
          if (index === 0) path.moveTo(x, y);
          else path.lineTo(x, y);
        });
        path.closePath();
      }
    }
    built.push(path);
  }

  return built;
}

/** Land as a bitmap, rasterised from the polygons at full canvas resolution. */
function buildLandMask() {
  const off = new OffscreenCanvas(WIDTH, HEIGHT);
  const octx = off.getContext('2d', { willReadFrequently: true });

  octx.fillStyle = '#ffffff';
  for (const path of paths) octx.fill(path, 'evenodd');

  const { data: pixels } = octx.getImageData(0, 0, WIDTH, HEIGHT);
  const mask = new Uint8Array(WIDTH * HEIGHT);
  for (let i = 0; i < mask.length; i++) {
    mask[i] = pixels[i * 4] > 127 ? 1 : 0;
  }
  return mask;
}

/** The outlines, drawn once into their own canvas and composited each frame. */
function buildBorderLayer() {
  const layer = new OffscreenCanvas(WIDTH, HEIGHT);
  const lctx = layer.getContext('2d');

  lctx.lineJoin = 'round';
  lctx.lineCap = 'round';
  lctx.strokeStyle = 'rgba(168, 188, 216, 0.34)';
  lctx.lineWidth = Math.max(1, 0.42 * SCALE);

  for (const path of paths) lctx.stroke(path);

  return layer;
}

/**
 * The key, drawn once into its own layer like the borders.
 *
 * Moved to the bottom. Top-left put it straight over Ireland and northern
 * Britain, so the type fought the busiest corner of the map and the map lost.
 * The bottom strip is mostly sea in this view, and a gradient scrim under it
 * guarantees the text stays readable whatever the flow happens to be doing
 * there on a given frame - without it, white type over bright streamlines is
 * unreadable on maybe one frame in five.
 *
 * A picture like this has to survive being scrolled past with no caption
 * attached, because by the time anyone reads a caption they are on a different
 * site. The bar says what the colours mean, the line under it says what is
 * being drawn, and the mark in the corner is something a person can type into a
 * browser - which is also the only way to be found on subreddits that ban
 * outright links.
 */
function buildAnnotationLayer() {
  const layer = new OffscreenCanvas(WIDTH, HEIGHT);
  const a = layer.getContext('2d');

  const margin = Math.round(34 * SCALE);
  const px = (n) => Math.round(n * SCALE);
  const mono = (size, weight = '') =>
    `${weight} ${px(size)}px ui-monospace, Menlo, Consolas, monospace`.trim();

  // Scrim: transparent at the top, near-solid at the very bottom.
  // Kept just tall enough to sit behind the type. The first attempt ran 190
  // units up the frame and swallowed Iberia and Italy whole - a scrim that
  // takes a third of the map to make one line readable is not a trade worth
  // making.
  const scrimTop = HEIGHT - px(124);
  const scrim = a.createLinearGradient(0, scrimTop, 0, HEIGHT);
  scrim.addColorStop(0, 'rgba(5, 7, 11, 0)');
  scrim.addColorStop(0.45, 'rgba(5, 7, 11, 0.6)');
  scrim.addColorStop(1, 'rgba(5, 7, 11, 0.9)');
  a.fillStyle = scrim;
  a.fillRect(0, scrimTop, WIDTH, HEIGHT - scrimTop);

  const baseline = HEIGHT - margin;

  a.textBaseline = 'alphabetic';
  a.textAlign = 'left';

  // Title.
  a.fillStyle = 'rgba(238, 242, 248, 0.97)';
  a.font = mono(23, '600');
  a.fillText('10 m wind over Europe', margin, baseline - px(70));

  // Colour bar, drawn through the same ramp the particles use.
  const barW = px(210);
  const barH = px(8);
  const barY = baseline - px(50);
  for (let i = 0; i < barW; i++) {
    const [r, g, b] = rampAt(i / (barW - 1));
    a.fillStyle = `rgb(${r},${g},${b})`;
    a.fillRect(margin + i, barY, 1, barH);
  }
  a.strokeStyle = 'rgba(255, 255, 255, 0.16)';
  a.lineWidth = Math.max(1, px(0.4));
  a.strokeRect(margin + 0.5, barY + 0.5, barW - 1, barH - 1);

  // Ticks at real degrees.
  a.textAlign = 'center';
  a.font = mono(11);
  for (const degrees of [5, 10, 15, 20, 25]) {
    const x = margin + ((degrees - TEMP_MIN) / (TEMP_MAX - TEMP_MIN)) * (barW - 1);
    a.fillStyle = 'rgba(190, 202, 220, 0.92)';
    a.fillText(`${degrees}°`, x, barY + barH + px(15));
  }

  a.textAlign = 'left';
  a.fillStyle = 'rgba(150, 162, 180, 0.92)';
  a.font = mono(11);
  a.fillText('2 m air temperature', margin + barW + px(14), barY + barH - px(1));

  // Provenance. Replace this line with the model and initialisation time once
  // the field is real - it is the first thing anyone who knows the subject
  // will look for, and its absence is more conspicuous than its content.
  a.fillStyle = 'rgba(120, 130, 148, 0.92)';
  a.font = mono(11);
  a.fillText(SOURCE_LINE, margin, baseline);

  a.textAlign = 'right';
  a.fillStyle = 'rgba(104, 114, 132, 0.92)';
  a.fillText(WATERMARK, WIDTH - margin, baseline);

  return layer;
}

/**
 * Stand-in for real model output.
 *
 * Two smooth rotating cells plus a latitude gradient - enough structure that
 * the streamlines curve and converge the way a real pressure field makes them,
 * which is all that is needed to judge whether the technique looks right.
 *
 * It drifts slowly with the clock. A static field settles into fixed lines
 * within a couple of seconds and then nothing changes, which looks like a
 * frozen image with noise on it; a field that evolves keeps the streamlines
 * migrating the way real weather does, and is what makes it worth watching for
 * more than a moment.
 */
function fieldAt(x, y) {
  const lon = VIEW.west + (x / WIDTH) * (VIEW.east - VIEW.west);
  const lat = VIEW.north - (y / HEIGHT) * (VIEW.north - VIEW.south);
  const t = clock * 0.0009;

  const u = Math.sin(lat * 0.35 + t) * 1.6 + Math.cos(lon * 0.22 + 1.1 - t * 0.7) * 1.2;
  const v = Math.cos(lat * 0.27 + 0.4 - t) * 1.3 - Math.sin(lon * 0.31 + t * 0.5) * 1.5;

  const temperature = 26 - (lat - VIEW.south) * 0.55 + Math.sin(lon * 0.4 + t * 0.6) * 2.2;

  return { u, v, temperature };
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

function clamp01(v) {
  return Math.min(1, Math.max(0, v));
}
