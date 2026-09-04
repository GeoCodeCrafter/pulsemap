/**
 * Renders a geographic dataset as an animated map, driven entirely by config.
 *
 * The whole idea is that a map like this is three mappings from data to ink:
 *
 *   size    a number to stroke width or dot radius
 *   colour  a number to a ramp, or a category to a palette
 *   pulse   an *ordering* to a travelling highlight
 *
 * The third is the one worth having. A pulse is nothing more than "brighten
 * the features whose value is near X, then sweep X" - so any field that orders
 * the data animates it, with no simulation anywhere. River segments carry their
 * distance to the sea, so sweeping that sends a wave down every river at once,
 * headwaters first. Earthquakes carry a timestamp, so sweeping that replays
 * years of seismicity in order. Same code, and it would equally take depth,
 * elevation, or the year a building went up.
 *
 * Because the phase is taken modulo one, the loop is seamless by construction:
 * at t = 1 every crest sits exactly where the previous one stood at t = 0.
 * There is no cross-fade and no hidden seam.
 */

const params = new URLSearchParams(location.search);
const config = await (await fetch(`../${params.get('config')}`)).json();
const collection = await (await fetch(`../${config.data}`)).json();

const WIDTH = Number(params.get('w')) || config.width || 2400;
const VIEW = config.view;

/**
 * Longitude lines converge, so away from the equator a degree of longitude is
 * shorter than a degree of latitude. For a regional map the cosine correction
 * at the middle latitude keeps proportions honest - without it Britain comes
 * out nearly twice as wide as it should be. For a whole-world frame there is no
 * single latitude to correct at, so plate carree it is, and the poles stretch.
 */
const SQUEEZE =
  config.projection === 'plate'
    ? 1
    : Math.cos((((VIEW.north + VIEW.south) / 2) * Math.PI) / 180);

const HEIGHT =
  2 *
  Math.round(
    (WIDTH * (VIEW.north - VIEW.south)) / ((VIEW.east - VIEW.west) * SQUEEZE) / 2,
  );

/** Everything visual is expressed against the width the look was tuned at. */
const SCALE = WIDTH / (config.width || 2400);

const canvas = document.getElementById('map');
canvas.width = WIDTH;
canvas.height = HEIGHT;
const ctx = canvas.getContext('2d');

const features = prepare();

window.pulsemap = {
  size: { width: WIDTH, height: HEIGHT },
  count: features.length,
  title: config.title,
  draw,
};

draw(0);

/**
 * Precomputes everything that does not change between frames.
 *
 * With tens of thousands of features redrawn sixty times a second there is no
 * budget to reproject coordinates or recompute a colour ramp per frame, and
 * profiling a naive version showed almost all of it going on exactly that.
 */
function prepare() {
  const pulse = config.pulse;
  let low = Infinity;
  let high = -Infinity;

  if (pulse?.mode === 'sweep') {
    for (const f of collection.features) {
      const v = f.properties[pulse.field];
      if (typeof v !== 'number') continue;
      if (v < low) low = v;
      if (v > high) high = v;
    }
  }
  const range = high - low || 1;

  return collection.features.map((feature) => {
    const p = feature.properties ?? {};

    // Phase is where this feature sits in the pulse's cycle, 0 to 1.
    //
    // 'cycle' repeats every `spacing` units of the field, which suits a
    // quantity with no natural end - distance along a river network keeps
    // going, so several crests share the map at once. 'sweep' normalises the
    // field across the whole dataset instead, for a quantity with real bounds
    // like a date range, where one window crossing once is the whole story.
    let phase = 0;
    if (pulse) {
      const value = p[pulse.field] ?? 0;
      phase =
        pulse.mode === 'sweep'
          ? (value - low) / range
          : (value / pulse.spacing) % 1;
    }

    return {
      geometry:
        config.kind === 'points'
          ? project(feature.geometry.coordinates)
          : feature.geometry.coordinates.map(project),
      size: sizeOf(p),
      fill: colourOf(p).join(','),
      unit: Number(p[config.size?.field] ?? 1),
      phase,
    };
  });
}

/**
 * @param {number} t Position in the loop, 0 to 1.
 */
function draw(t = 0) {
  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = config.background ?? '#04060a';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  // Additive, so overlapping features accumulate light instead of painting
  // over one another. A confluence of a hundred streams, or a subduction zone
  // holding thousands of events, then reads brighter than a lone feature -
  // which is real information rather than a flat wash of the top colour.
  ctx.globalCompositeOperation = 'lighter';
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';

  const a = config.alpha ?? {};
  const pulse = config.pulse;
  const direction = pulse?.direction === 'up' ? -1 : 1;
  const spread = pulse?.width ?? 0.1;

  for (const feature of features) {
    let glow = 0;
    if (pulse) {
      const wrapped = (((feature.phase + direction * t) % 1) + 1) % 1;
      const offset = Math.min(wrapped, 1 - wrapped);
      glow = Math.exp(-((offset / spread) ** 2));
    }

    // The base layer never goes away. Between crests the whole structure is
    // still legible, which is what stops it reading as scattered blinking and
    // lets someone pause on any frame and still see the map.
    const alpha =
      (a.base ?? 0.2) +
      (a.perUnit ?? 0) * feature.unit +
      glow * ((a.pulse ?? 0.4) + (a.pulsePerUnit ?? 0) * feature.unit);

    const size = feature.size * (1 + glow * (config.size?.bloom ?? 0.6));

    if (config.kind === 'points') {
      ctx.fillStyle = `rgba(${feature.fill},${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(feature.geometry[0], feature.geometry[1], size, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.strokeStyle = `rgba(${feature.fill},${alpha.toFixed(3)})`;
      ctx.lineWidth = size;
      ctx.beginPath();
      feature.geometry.forEach(([x, y], index) => {
        if (index === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      });
      ctx.stroke();
    }
  }

  ctx.globalCompositeOperation = 'source-over';
  annotate();
}

/**
 * Title, source and mark.
 *
 * A picture like this has to survive being scrolled past with no caption,
 * because by the time anyone reads a caption they are on a different site. The
 * source line matters more than it looks: the first thing anyone who knows the
 * subject asks is where the data came from, and its absence is far more
 * conspicuous than its presence. The mark in the corner is something a person
 * can type into a browser, which is also the only route to being found on the
 * subreddits that ban outright links.
 */
function annotate() {
  const px = (n) => Math.round(n * SCALE);
  const margin = px(30);
  const mono = (size, weight = '') =>
    `${weight} ${px(size)}px ui-monospace, Menlo, Consolas, monospace`.trim();

  // Just tall enough to sit behind the type. White text over a bright feature
  // is unreadable on roughly one frame in five, and a scrim deep enough to fix
  // that while covering a third of the map is not a trade worth making.
  const top = HEIGHT - px(96);
  const scrim = ctx.createLinearGradient(0, top, 0, HEIGHT);
  scrim.addColorStop(0, 'rgba(4, 6, 10, 0)');
  scrim.addColorStop(0.5, 'rgba(4, 6, 10, 0.66)');
  scrim.addColorStop(1, 'rgba(4, 6, 10, 0.93)');
  ctx.fillStyle = scrim;
  ctx.fillRect(0, top, WIDTH, HEIGHT - top);

  const baseline = HEIGHT - margin;

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  if (config.title) {
    ctx.fillStyle = 'rgba(238, 242, 248, 0.97)';
    ctx.font = mono(19, '600');
    ctx.fillText(config.title, margin, baseline - px(24));
  }

  if (config.source) {
    ctx.fillStyle = 'rgba(126, 137, 156, 0.95)';
    ctx.font = mono(11);
    ctx.fillText(config.source, margin, baseline);
  }

  if (config.watermark) {
    ctx.textAlign = 'right';
    ctx.fillStyle = 'rgba(104, 114, 132, 0.95)';
    ctx.font = mono(11);
    ctx.fillText(config.watermark, WIDTH - margin, baseline);
  }
}

function project([lon, lat]) {
  return [
    ((lon - VIEW.west) / (VIEW.east - VIEW.west)) * (WIDTH - 1),
    ((VIEW.north - lat) / (VIEW.north - VIEW.south)) * (HEIGHT - 1),
  ];
}

function sizeOf(properties) {
  const s = config.size;
  if (!s) return SCALE;
  const value = Math.max(0, Number(properties[s.field] ?? 1) - (s.offset ?? 0));
  return Math.max(SCALE * (s.min ?? 0.5), SCALE * s.base * Math.pow(value, s.exponent ?? 1));
}

function colourOf(properties) {
  const c = config.colour;
  if (!c) return [255, 255, 255];

  const value = properties[c.field];

  // Categorical ids get a small hand-picked palette rather than a hash into
  // hue space. Random hues per category look like noise however good the
  // geometry is; a short palette keeps the image coherent and still tells
  // neighbours apart, which is all the colour has to do here.
  if (c.mode === 'categorical') {
    return c.palette[Math.abs(Math.trunc(value ?? 0)) % c.palette.length];
  }

  const stops = c.stops;
  for (let i = 1; i < stops.length; i++) {
    if (value <= stops[i][0]) {
      const [v0, c0] = stops[i - 1];
      const [v1, c1] = stops[i];
      const k = (value - v0) / (v1 - v0);
      return [0, 1, 2].map((n) => Math.round(c0[n] + k * (c1[n] - c0[n])));
    }
  }
  return stops[stops.length - 1][1];
}
