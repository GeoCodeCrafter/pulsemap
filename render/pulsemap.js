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
const collection = config.data.endsWith('.csv')
  ? await loadCsv(config.data)
  : await (await fetch(`../${config.data}`)).json();

const WIDTH = Number(params.get('w')) || config.width || 2400;
const VIEW = config.view;

/**
 * Longitude lines converge, so away from the equator a degree of longitude is
 * shorter than a degree of latitude. For a regional map the cosine correction
 * at the middle latitude keeps proportions honest - without it Britain comes
 * out nearly twice as wide as it should be. For a whole-world frame there is no
 * single latitude to correct at, so plate carree it is, and the poles stretch.
 */
const GLOBE = config.projection === 'globe';

const SQUEEZE =
  config.projection === 'plate'
    ? 1
    : Math.cos((((VIEW.north + VIEW.south) / 2) * Math.PI) / 180);

// A globe wants a square frame; anything else follows the view's own shape.
const HEIGHT = GLOBE
  ? WIDTH
  : 2 *
    Math.round(
      (WIDTH * (VIEW.north - VIEW.south)) / ((VIEW.east - VIEW.west) * SQUEEZE) / 2,
    );

const DEG = Math.PI / 180;
const RADIUS = (WIDTH / 2) * ((config.globe?.fill ?? 0.9));
const CX = WIDTH / 2;
const CY = HEIGHT / 2;

/** Tilt of the viewing axis. A few degrees of north reads better than dead on. */
const PHI0 = (config.globe?.tilt ?? 16) * DEG;
const SIN_PHI0 = Math.sin(PHI0);
const COS_PHI0 = Math.cos(PHI0);

/**
 * Current rotation, in radians, set once per frame.
 *
 * On a globe the projection depends on time, so unlike the flat maps nothing
 * can be projected ahead of the render - every vertex is transformed per frame.
 * That sounds expensive and is not: it is four trig calls per point, and even
 * the cyclone set at 280,000 vertices costs a few milliseconds a frame.
 */
let rotation = 0;

/** Everything visual is expressed against the width the look was tuned at. */
const SCALE = WIDTH / (config.width || 2400);

const canvas = document.getElementById('map');
canvas.width = WIDTH;
canvas.height = HEIGHT;
const ctx = canvas.getContext('2d');

/**
 * Reads a CSV of coordinates straight into the same shape as a GeoJSON layer.
 *
 * Most open data is published as a CSV with latitude and longitude columns, not
 * as GeoJSON, so without this every new dataset needs a conversion script
 * written before anything can be drawn. Naming the two columns in the config is
 * the whole setup.
 *
 * `require` drops rows with an empty value in any named column, which matters
 * more than it sounds: a row missing its commissioning year would otherwise
 * become year zero and sit permanently at the start of the pulse.
 */
async function loadCsv(path) {
  const text = await (await fetch(`../${path}`)).text();
  const rows = parseCsv(text);
  const header = rows.shift() ?? [];
  const index = Object.fromEntries(header.map((name, i) => [name.trim(), i]));

  const spec = config.csv ?? {};
  const required = spec.require ?? [];
  const features = [];

  for (const row of rows) {
    const lon = Number(row[index[spec.lon ?? 'longitude']]);
    const lat = Number(row[index[spec.lat ?? 'latitude']]);
    if (!Number.isFinite(lon) || !Number.isFinite(lat)) continue;
    if (required.some((name) => !String(row[index[name]] ?? '').trim())) continue;

    const properties = {};
    for (const [name, at] of Object.entries(index)) {
      const raw = row[at];
      const asNumber = Number(raw);
      properties[name] = raw !== '' && Number.isFinite(asNumber) ? asNumber : raw;
    }

    features.push({ type: 'Feature', properties, geometry: { type: 'Point', coordinates: [lon, lat] } });
  }

  return { type: 'FeatureCollection', features };
}

/**
 * Minimal RFC 4180 parser.
 *
 * Splitting on commas is wrong the moment a field is quoted and contains one,
 * and plant and place names contain them constantly - "Nuevo Leon, Mexico"
 * would silently shift every later column by one.
 */
function parseCsv(text) {
  const rows = [];
  let row = [];
  let field = '';
  let quoted = false;

  for (let i = 0; i < text.length; i++) {
    const char = text[i];

    if (quoted) {
      if (char === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i += 1;
        } else {
          quoted = false;
        }
      } else {
        field += char;
      }
      continue;
    }

    if (char === '"') quoted = true;
    else if (char === ',') {
      row.push(field);
      field = '';
    } else if (char === '\n') {
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else if (char !== '\r') {
      field += char;
    }
  }

  if (field !== '' || row.length) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

/**
 * An optional faint underlay, drawn behind the data and never animated.
 *
 * Most of these maps don't need one: rivers draw their own coastline and
 * earthquakes draw the plate boundaries, and putting geography under either
 * would be answering a question the picture is supposed to raise. Cyclone
 * tracks are the opposite case - they sit over open ocean and form no
 * recognisable shape, so without a coastline you genuinely cannot tell what
 * you are looking at or where.
 */
const basemap = config.basemap
  ? await (await fetch(`../${config.basemap.data}`)).json()
  : null;

/**
 * The basemap as one Path2D, built once.
 *
 * It never changes between frames, so rebuilding it per frame was 240 country
 * outlines of geometry walked several hundred times for an identical result.
 */
const basemapPath = basemap && !GLOBE ? buildBasemapPath() : null;

/**
 * One path per country, for filling.
 *
 * The outlines have to be filled per feature rather than as one combined path:
 * `evenodd` on a single path would treat two overlapping countries as a hole
 * and punch them out of each other. Per feature, the same rule correctly cuts
 * only the interior rings - lakes.
 */
const basemapShapes =
  basemap && config.basemap.fill && !GLOBE
    ? basemap.features.map((f) => ringPath(f.geometry))
    : null;

const graticulePath = config.graticule && !GLOBE ? buildGraticule() : null;

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
      // On a globe the screen position changes every frame, so the raw
      // coordinates are kept and transformed at draw time instead.
      geometry: GLOBE
        ? feature.geometry.coordinates
        : config.kind === 'points'
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
  // One full turn per loop by default, so the rotation is seamless for the
  // same reason the pulse is: it returns exactly to where it started.
  rotation = GLOBE ? t * (config.globe?.spin ?? 1) * Math.PI * 2 : 0;

  ctx.globalCompositeOperation = 'source-over';
  ctx.fillStyle = config.background ?? '#04060a';
  ctx.fillRect(0, 0, WIDTH, HEIGHT);

  if (GLOBE) drawOcean();
  if (basemap) drawBasemap();

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
  const tail = pulse?.tail ?? 1;
  const bloom = config.glow;

  for (const feature of features) {
    let glow = 0;
    if (pulse) {
      const wrapped = (((feature.phase + direction * t) % 1) + 1) % 1;

      // Asymmetric on purpose. A symmetric crest makes features brighten and
      // dim in place, which reads as blinking; a sharp leading edge with a
      // long decay behind it reads as something travelling, and for tracks
      // that is exactly what is happening. `tail` is a multiple of the head
      // width - 1 gives the old symmetric behaviour.
      const ahead = wrapped;
      const behind = 1 - wrapped;
      glow = Math.max(
        Math.exp(-((ahead / spread) ** 2)),
        Math.exp(-((behind / (spread * tail)) ** 2)),
      );
    }

    // The base layer never goes away. Between crests the whole structure is
    // still legible, which is what stops it reading as scattered blinking and
    // lets someone pause on any frame and still see the map.
    const alpha =
      (a.base ?? 0.2) +
      (a.perUnit ?? 0) * feature.unit +
      glow * ((a.pulse ?? 0.4) + (a.pulsePerUnit ?? 0) * feature.unit);

    const size = feature.size * (1 + glow * (config.size?.bloom ?? 0.6));

    // Bloom: a wide, dim pass under the sharp one, so bright features bleed
    // light rather than ending at a hard edge. Gated on a threshold because
    // doubling the draw calls for every faint feature costs a lot of time to
    // add glow nobody can see - only the strong ones earn it.
    const glowing = bloom && feature.unit >= (bloom.min ?? 0) && glow > 0.02;

    if (config.kind === 'points') {
      const [x, y, visible] = GLOBE ? project(feature.geometry) : feature.geometry;
      if (GLOBE && !visible) continue;
      if (glowing) {
        ctx.fillStyle = `rgba(${feature.fill},${(alpha * (bloom.alpha ?? 0.15)).toFixed(3)})`;
        ctx.beginPath();
        ctx.arc(x, y, size * (bloom.width ?? 4), 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.fillStyle = `rgba(${feature.fill},${alpha.toFixed(3)})`;
      ctx.beginPath();
      ctx.arc(x, y, size, 0, Math.PI * 2);
      ctx.fill();
    } else {
      ctx.beginPath();
      if (GLOBE) {
        // Break the line wherever it crosses the horizon rather than drawing
        // through the planet. A track running round the far side would
        // otherwise appear as a chord straight across the disc.
        let pen = false;
        for (const position of feature.geometry) {
          const [x, y, visible] = project(position);
          if (!visible) {
            pen = false;
            continue;
          }
          if (pen) ctx.lineTo(x, y);
          else ctx.moveTo(x, y);
          pen = true;
        }
      } else {
        feature.geometry.forEach(([x, y], index) => {
          if (index === 0) ctx.moveTo(x, y);
          else ctx.lineTo(x, y);
        });
      }

      if (glowing) {
        ctx.strokeStyle = `rgba(${feature.fill},${(alpha * (bloom.alpha ?? 0.15)).toFixed(3)})`;
        ctx.lineWidth = size * (bloom.width ?? 4);
        ctx.stroke();
      }

      ctx.strokeStyle = `rgba(${feature.fill},${alpha.toFixed(3)})`;
      ctx.lineWidth = size;
      ctx.stroke();
    }
  }

  if (GLOBE && config.globe?.atmosphere) drawAtmosphere();

  ctx.globalCompositeOperation = 'source-over';
  annotate();
}

/**
 * A rim of scattered light just outside the disc.
 *
 * Drawn last, over the data, because that is where it is: looking at a planet
 * you see its atmosphere in front of the limb as well as beside it. It is the
 * single cheapest thing that makes a flat circle read as a sphere - the
 * radial shading suggests curvature, but the halo is what says there is air.
 */
function drawAtmosphere() {
  const a = config.globe.atmosphere;
  const spread = a.spread ?? 0.09;
  const colour = (a.colour ?? [96, 156, 226]).join(',');

  const rim = ctx.createRadialGradient(CX, CY, RADIUS * (1 - spread * 0.5), CX, CY, RADIUS * (1 + spread));
  rim.addColorStop(0, `rgba(${colour},0)`);
  rim.addColorStop(0.5, `rgba(${colour},${(a.alpha ?? 0.3).toFixed(3)})`);
  rim.addColorStop(1, `rgba(${colour},0)`);

  ctx.globalCompositeOperation = 'lighter';
  ctx.fillStyle = rim;
  ctx.beginPath();
  ctx.arc(CX, CY, RADIUS * (1 + spread), 0, Math.PI * 2);
  ctx.fill();
  ctx.globalCompositeOperation = 'source-over';
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
  // Sized as a fraction of the frame, not scaled off the render width.
  //
  // Tying type to SCALE meant a smaller render produced smaller text, so the
  // loop exported for social ended up with a 13px title that a video codec
  // then finished off. Type has to be legible at whatever size the thing is
  // finally *watched* at, which is usually a few hundred pixels wide in a
  // feed, so it is pinned to a proportion of the frame instead.
  const px = (fraction) => Math.max(9, Math.round(WIDTH * fraction));
  const margin = px(0.014);
  const mono = (fraction, weight = '') =>
    `${weight} ${px(fraction)}px ui-monospace, Menlo, Consolas, monospace`.trim();

  // The scrim only earns its place under a block of text. With just the mark in
  // the corner there is nothing to protect, and a gradient across the full
  // width to serve one short line is a band of dead map for no reason - a
  // shadow on the mark itself does the same job for nothing.
  if (config.title || config.source) {
    const top = HEIGHT - px(0.046);
    const scrim = ctx.createLinearGradient(0, top, 0, HEIGHT);
    scrim.addColorStop(0, 'rgba(4, 6, 10, 0)');
    scrim.addColorStop(0.5, 'rgba(4, 6, 10, 0.66)');
    scrim.addColorStop(1, 'rgba(4, 6, 10, 0.93)');
    ctx.fillStyle = scrim;
    ctx.fillRect(0, top, WIDTH, HEIGHT - top);
  }

  const baseline = HEIGHT - margin;

  ctx.textAlign = 'left';
  ctx.textBaseline = 'alphabetic';

  if (config.title) {
    ctx.fillStyle = 'rgba(238, 242, 248, 0.97)';
    ctx.font = mono(0.0125, '600');
    ctx.fillText(config.title, margin, baseline - px(0.0115));
  }

  if (config.source) {
    ctx.fillStyle = 'rgba(126, 137, 156, 0.95)';
    ctx.font = mono(0.0068);
    ctx.fillText(config.source, margin, baseline);
  }

  if (config.watermark) {
    ctx.textAlign = 'right';
    ctx.font = mono(0.0068);
    // Standing on its own now, so it carries its own contrast rather than
    // relying on a scrim that is no longer drawn.
    ctx.shadowColor = 'rgba(0, 0, 0, 0.9)';
    ctx.shadowBlur = px(0.004);
    ctx.fillStyle = 'rgba(126, 138, 158, 0.95)';
    ctx.fillText(config.watermark, WIDTH - margin, baseline);
    ctx.shadowBlur = 0;
  }
}

/**
 * The basemap, rebuilt each frame because the projection has moved.
 *
 * Rings with nothing visible are skipped outright. Points that are merely off
 * the near face within an otherwise visible ring get pushed to the limb, which
 * keeps a country straddling the horizon as a closed shape instead of a torn
 * one - a proper spherical clip against the horizon circle would be exact, but
 * at this line weight nobody can tell the difference.
 */
function drawBasemapGlobe() {
  const b = config.basemap;
  const colour = b.colour.join(',');

  if (config.graticule) {
    const g = config.graticule;
    ctx.strokeStyle = `rgba(${(g.colour ?? [90, 116, 150]).join(',')},${g.alpha ?? 0.1})`;
    ctx.lineWidth = Math.max(0.5, (g.width ?? 0.5) * SCALE);
    ctx.stroke(globeGraticule(g.step ?? 15));
  }

  if (b.fill) {
    ctx.fillStyle = `rgba(${b.fill.colour.join(',')},${b.fill.alpha ?? 1})`;
    for (const feature of basemap.features) {
      const shape = globeShape(feature.geometry);
      if (shape) ctx.fill(shape, 'evenodd');
    }
  }

  const outline = globeOutline();
  const width = Math.max(0.5, (b.width ?? 0.9) * SCALE);
  const alpha = b.alpha ?? 0.85;

  ctx.globalCompositeOperation = 'lighter';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const halo = b.glow;
  if (halo) {
    const passes = halo.passes ?? 3;
    for (let i = passes; i >= 1; i--) {
      const fraction = i / passes;
      ctx.strokeStyle = `rgba(${colour},${(alpha * (halo.alpha ?? 0.1) * (1 - fraction * 0.6)).toFixed(4)})`;
      ctx.lineWidth = width * (halo.width ?? 6) * fraction;
      ctx.stroke(outline);
    }
  }

  ctx.strokeStyle = `rgba(${colour},${alpha})`;
  ctx.lineWidth = width;
  ctx.stroke(outline);
  ctx.globalCompositeOperation = 'source-over';
}

/** Filled land for one country, or null when it is entirely on the far side. */
function globeShape(geometry) {
  const path = new Path2D();
  let drew = false;

  for (const ring of rings(geometry)) {
    const projected = ring.map(project);
    if (!projected.some((point) => point[2])) continue;

    projected.forEach((point, index) => {
      const [x, y] = point[2] ? point : toLimb(point);
      if (index === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });
    path.closePath();
    drew = true;
  }

  return drew ? path : null;
}

/** Coastlines and borders, broken wherever they pass behind the horizon. */
function globeOutline() {
  const path = new Path2D();

  for (const feature of basemap.features) {
    for (const ring of rings(feature.geometry)) {
      let pen = false;
      for (const position of ring) {
        const [x, y, visible] = project(position);
        if (!visible) {
          pen = false;
          continue;
        }
        if (pen) path.lineTo(x, y);
        else path.moveTo(x, y);
        pen = true;
      }
    }
  }

  return path;
}

/**
 * Meridians and parallels as curves.
 *
 * On the flat projection these are straight lines between two endpoints. On a
 * sphere they are not, so each one is walked in small steps - the comment on
 * the flat version warning about exactly this is why it was cheap to add.
 */
function globeGraticule(step) {
  const path = new Path2D();
  const fine = 3;

  const line = (points) => {
    let pen = false;
    for (const position of points) {
      const [x, y, visible] = project(position);
      if (!visible) {
        pen = false;
        continue;
      }
      if (pen) path.lineTo(x, y);
      else path.moveTo(x, y);
      pen = true;
    }
  };

  for (let lon = -180; lon < 180; lon += step) {
    const points = [];
    for (let lat = -90; lat <= 90; lat += fine) points.push([lon, lat]);
    line(points);
  }

  for (let lat = -90 + step; lat < 90; lat += step) {
    const points = [];
    for (let lon = -180; lon <= 180; lon += fine) points.push([lon, lat]);
    line(points);
  }

  return path;
}

/**
 * The sphere itself: a filled disc with a soft edge.
 *
 * Without it the land floats in the same black as the surrounding page and
 * there is no planet, just a scattering of continents. The gradient does the
 * work of suggesting curvature - flat fill reads as a sticker.
 */
function drawOcean() {
  const g = config.globe ?? {};
  const ocean = g.ocean ?? [10, 18, 32];
  const edge = g.edge ?? [4, 8, 16];

  const shade = ctx.createRadialGradient(
    CX - RADIUS * 0.35,
    CY - RADIUS * 0.35,
    RADIUS * 0.1,
    CX,
    CY,
    RADIUS,
  );
  shade.addColorStop(0, `rgb(${ocean.join(',')})`);
  shade.addColorStop(1, `rgb(${edge.join(',')})`);

  ctx.fillStyle = shade;
  ctx.beginPath();
  ctx.arc(CX, CY, RADIUS, 0, Math.PI * 2);
  ctx.fill();
}

/**
 * Accepts line or polygon geometry. Polygons are stroked rather than filled,
 * because country outlines give the coast and the borders from one file where
 * a coastline set has no borders in it at all.
 */
function buildBasemapPath() {
  const path = new Path2D();
  for (const feature of basemap.features) addRings(path, feature.geometry);
  return path;
}

function ringPath(geometry) {
  const path = new Path2D();
  addRings(path, geometry);
  return path;
}

function addRings(path, geometry) {
  for (const part of rings(geometry)) {
    part.forEach((position, index) => {
      const [x, y] = project(position);
      if (index === 0) path.moveTo(x, y);
      else path.lineTo(x, y);
    });
  }
}

/**
 * Meridians and parallels.
 *
 * Straight lines are correct here only because the projection is
 * equirectangular, which maps longitude and latitude linearly onto x and y.
 * Any projection with curvature would need these subdivided.
 */
function buildGraticule() {
  const step = config.graticule.step ?? 15;
  const path = new Path2D();

  for (let lon = Math.ceil(VIEW.west / step) * step; lon <= VIEW.east; lon += step) {
    const [x0, y0] = project([lon, VIEW.north]);
    const [x1, y1] = project([lon, VIEW.south]);
    path.moveTo(x0, y0);
    path.lineTo(x1, y1);
  }

  for (let lat = Math.ceil(VIEW.south / step) * step; lat <= VIEW.north; lat += step) {
    const [x0, y0] = project([VIEW.west, lat]);
    const [x1, y1] = project([VIEW.east, lat]);
    path.moveTo(x0, y0);
    path.lineTo(x1, y1);
  }

  return path;
}

/**
 * Reference, not subject - but not a bare hairline either.
 *
 * Stroked several times at decreasing width and increasing opacity, which
 * builds a soft halo around a crisp core. A single thin line reads as a
 * wireframe sitting on top of the picture; the halo makes the geography feel
 * like it is behind the data and lit by it, and it also survives video
 * encoding far better, because there is a gradient either side of the line
 * rather than one isolated pixel for the codec to discard.
 */
function drawBasemap() {
  if (GLOBE) {
    drawBasemapGlobe();
    return;
  }

  const b = config.basemap;
  const colour = b.colour.join(',');

  // Graticule first, so the land fill covers it and the grid reads over water
  // only. Drawn over everything it competes with the data; drawn over ocean it
  // just stops the empty half of the frame being a void.
  if (graticulePath) {
    const g = config.graticule;
    ctx.globalCompositeOperation = 'source-over';
    ctx.strokeStyle = `rgba(${(g.colour ?? [90, 116, 150]).join(',')},${g.alpha ?? 0.1})`;
    ctx.lineWidth = Math.max(0.5, (g.width ?? 0.5) * SCALE);
    ctx.stroke(graticulePath);
  }

  // Land as a solid, barely-lifted tone. Outlines alone leave the continents
  // as empty as the sea, so nothing tells you which is which until you already
  // know the shapes.
  if (basemapShapes) {
    ctx.globalCompositeOperation = 'source-over';
    ctx.fillStyle = `rgba(${b.fill.colour.join(',')},${b.fill.alpha ?? 1})`;
    for (const shape of basemapShapes) ctx.fill(shape, 'evenodd');
  }
  const width = Math.max(0.5, (b.width ?? 0.9) * SCALE);
  const alpha = b.alpha ?? 0.85;

  ctx.globalCompositeOperation = 'lighter';
  ctx.lineJoin = 'round';
  ctx.lineCap = 'round';

  const halo = b.glow;
  if (halo) {
    const passes = halo.passes ?? 3;
    for (let i = passes; i >= 1; i--) {
      const fraction = i / passes;
      ctx.strokeStyle = `rgba(${colour},${(alpha * (halo.alpha ?? 0.1) * (1 - fraction * 0.6)).toFixed(4)})`;
      ctx.lineWidth = width * (halo.width ?? 6) * fraction;
      ctx.stroke(basemapPath);
    }
  }

  ctx.strokeStyle = `rgba(${colour},${alpha})`;
  ctx.lineWidth = width;
  ctx.stroke(basemapPath);

  ctx.globalCompositeOperation = 'source-over';
}

/** Flattens any geometry type down to a list of coordinate rings. */
function rings(geometry) {
  switch (geometry?.type) {
    case 'LineString':
      return [geometry.coordinates];
    case 'MultiLineString':
    case 'Polygon':
      return geometry.coordinates;
    case 'MultiPolygon':
      return geometry.coordinates.flat();
    default:
      return [];
  }
}

function project([lon, lat]) {
  if (!GLOBE) {
    return [
      ((lon - VIEW.west) / (VIEW.east - VIEW.west)) * (WIDTH - 1),
      ((VIEW.north - lat) / (VIEW.north - VIEW.south)) * (HEIGHT - 1),
      true,
    ];
  }

  // Orthographic: the view from infinitely far away, which is what a globe in
  // a picture actually is. The third element is whether the point is on the
  // near face - without it the far hemisphere draws straight through, and
  // South America ends up sitting on top of Asia.
  const l = lon * DEG - rotation;
  const sinLat = Math.sin(lat * DEG);
  const cosLat = Math.cos(lat * DEG);
  const cosl = Math.cos(l);

  return [
    CX + RADIUS * cosLat * Math.sin(l),
    CY - RADIUS * (COS_PHI0 * sinLat - SIN_PHI0 * cosLat * cosl),
    SIN_PHI0 * sinLat + COS_PHI0 * cosLat * cosl > 0,
  ];
}

/** Pushes an off-globe point out onto the limb, so filled shapes keep a hull. */
function toLimb([x, y]) {
  const dx = x - CX;
  const dy = y - CY;
  const d = Math.hypot(dx, dy) || 1;
  return [CX + (dx / d) * RADIUS, CY + (dy / d) * RADIUS];
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

  // An explicit name-to-colour table. Hashing a category to a palette slot is
  // fine when the categories are arbitrary ids, but when they mean something -
  // coal, hydro, solar - the reader expects the colours to mean something too,
  // and a hash would put nuclear and wind next to each other at random.
  if (c.mode === 'lookup') {
    return c.map[value] ?? c.fallback ?? [140, 150, 170];
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
