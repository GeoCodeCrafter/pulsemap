# pulsemap

Turn geospatial data into animated maps. Point it at a GeoJSON, say which
fields drive width, colour and the pulse, get a 4K loop.

![Britain and Ireland drawn entirely from their rivers, with pulses of light travelling downstream to the sea](docs/readme-rivers-britain.gif)

There is no coastline in that image and no landmass. Every line is a river
segment. The islands appear because drainage fills the land and stops at the
sea, so the outline is a consequence of the data rather than something drawn
underneath it.

## The idea

A map like this is three mappings from data to ink:

| channel | takes | example |
| --- | --- | --- |
| **size** | a number | Strahler order to stroke width; magnitude to dot radius |
| **colour** | a number or a category | depth to a ramp; catchment id to a palette |
| **pulse** | an *ordering* | distance-to-sea; a timestamp |

The third one is why this is a tool rather than two scripts. A pulse is nothing
more than *"brighten the features whose value is near X, then sweep X"* — so
**any field that orders your data will animate it**, with no simulation
anywhere.

River segments carry their distance along the channel to the sea, so sweeping
that sends a wave down every river on the map at once, headwaters first,
estuaries last. Earthquakes carry a timestamp, so sweeping that replays years
of seismicity in the order it happened. Same code. It would equally take
elevation, depth, or the year a building went up.

Because the phase is taken modulo one, **the loop is seamless by
construction** — at `t = 1` every crest sits exactly where the previous one
stood at `t = 0`. No cross-fade, no hidden seam.

## Use it

```bash
npm install
npx playwright install chromium

npm run render configs/rivers-britain.json
```

That writes a full-size PNG, a GIF and a looping MP4 into `docs/`.

A config is the whole interface:

```jsonc
{
  "title": "Britain and Ireland, drawn using nothing but their rivers",
  "data": "data/rivers-britain.geojson",
  "kind": "lines",                     // or "points"
  "view":  { "north": 59.4, "south": 49.8, "west": -10.9, "east": 2.05 },

  "size":   { "field": "o", "base": 0.34, "exponent": 1.45 },
  "colour": { "field": "m", "mode": "categorical", "palette": [[96,210,255], ...] },
  "pulse":  { "field": "k", "mode": "cycle", "spacing": 76, "width": 0.115 }
}
```

`pulse.mode` is `cycle` for a quantity with no natural end — distance along a
river network keeps going, so several crests share the map at once — or `sweep`
for one with real bounds, like a date range, where a single window crossing
once is the whole story.

To use your own data, write a config pointing at your GeoJSON and name the
fields. Nothing in `render/pulsemap.js` knows what a river is.

## What's here

**Britain and Ireland from rivers** — 28,534 segments from HydroRIVERS. Width
is Strahler order: a headwater with no tributaries is order 1, and the order
rises each time two streams of equal size meet, so thousands of hairlines feed
a handful of trunks. Colour is catchment, which makes watersheds appear as
colour boundaries along ridges nobody drew.

```bash
npm run rivers britain && npm run render configs/rivers-britain.json
```

**Europe from rivers** — 72,674 segments, the Danube and Rhine systems dominating.

![Europe drawn from its rivers, each basin in its own colour](docs/rivers-europe.png)

```bash
npm run rivers europe && npm run render configs/rivers-europe.json
```

**Every earthquake since 2019** — 58,233 events, M4.5 and up, from the USGS
catalogue, pulsing in the order they occurred.

![The world's plate boundaries drawn only from earthquake locations](docs/readme-quakes.gif)

No coastlines and no plate boundaries are drawn — the boundaries appear because
that is where the crust moves. Colour is depth on the usual convention, shallow
warm and deep cold, and it earns its place: subduction zones show a colour
gradient across their width because the slab descends as it goes inland, which
you can watch happening along Japan, Tonga and South America.

The magnitude floor of 4.5 is deliberate. Below that the catalogue reflects
where the seismometers are rather than where the earth moves — California and
Japan blazing, the mid-Atlantic ridge barely present. At 4.5 global detection
is essentially complete.

```bash
npm run quakes && npm run render configs/quakes.json
```

## Things that turned out to matter

**Precompute everything that doesn't change between frames.** With tens of
thousands of features redrawn per frame there is no budget to reproject
coordinates or evaluate a colour ramp each time. Almost all of a naive
version's time went on exactly that.

**Additive blending, not alpha compositing.** Overlapping features should
accumulate light. A confluence of a hundred streams, or a subduction zone
holding thousands of events, then reads brighter than a lone feature — which is
real information rather than a flat wash of whatever drew last.

**Never render `t = 1`.** It is the same picture as `t = 0`, and including both
makes the loop hitch for exactly one frame.

**H.264 with 4:2:0 chroma cannot encode an odd dimension.** The aspect-ratio
maths landed on a height of 623 and x264 rejected every frame with a bare
"invalid argument" while ffmpeg wrote a zero-byte file. Canvas height is
rounded to even.

**Don't hash categories to hue.** Random colours per catchment read as noise
however good the geometry is. A short hand-picked palette keeps the image
coherent and still tells neighbours apart, which is all the colour has to do.

**Cosine-correct regional maps, don't correct world ones.** A degree of
longitude at 55°N is about 0.57 of a degree of latitude — without the
correction Britain comes out nearly twice as wide as it should be. On a
whole-world frame there is no single latitude to correct at, so plate carrée it
is, and the poles stretch.

## Layout

```
render/pulsemap.js   the engine - projection, channels, pulse, annotation
render/index.html    the page it draws into
configs/*.json       one file per map
scripts/render.mjs   headless capture -> png, gif, mp4
scripts/rivers.mjs   HydroRIVERS shapefile -> regional GeoJSON
scripts/quakes.mjs   USGS catalogue -> GeoJSON
```

Rendering happens in a headless Chromium rather than in Node, so the same
engine can serve a web page later, and because getting a native canvas to build
on Windows is an afternoon nobody gets back. Frames are driven one at a time
rather than filmed, so output is exact at any frame rate — an earlier version
recorded a live animation and produced a stuttering four frames a second.

## Data

- Rivers: [HydroRIVERS v1.0](https://www.hydrosheds.org/products/hydrorivers)
- Earthquakes: [USGS Earthquake Catalog](https://earthquake.usgs.gov/fdsnws/event/1/)
- Coastlines, where used: [Natural Earth](https://www.naturalearthdata.com/) (public domain)

`data/rivers-britain.geojson` is committed so a clone renders immediately. The
larger datasets are gitignored and rebuilt by the scripts above.

## Licence

MIT.
