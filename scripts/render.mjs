#!/usr/bin/env node
/**
 * Renders one frame per lead day and writes a still, a GIF and an mp4.
 *
 * The page draws to a canvas in a headless Chromium rather than in Node,
 * because that means one renderer serves both the artefacts and any web page
 * built on it later — and because getting a native canvas to build on Windows
 * is an afternoon nobody gets back.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync, rmSync, statSync } from 'node:fs';
import { extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';
import gifenc from 'gifenc';
import pngjs from 'pngjs';

const { GIFEncoder, applyPalette, quantize } = gifenc;
const { PNG } = pngjs;

const PORT = 5210;
const FPS = 25;
/** Seconds each day is held. Long enough to read the label. */
const HOLD = 1.1;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const server = createServer(async (request, response) => {
  const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
  const file = path === '/' ? 'render/index.html' : path.replace(/^\/+/, '');
  try {
    const body = await readFile(file);
    response.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    response.end(body);
  } catch {
    response.writeHead(404).end('not found');
  }
});

await new Promise((resolve) => server.listen(PORT, resolve));

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 800, height: 600 }, deviceScaleFactor: 1 });
await page.goto(`http://localhost:${PORT}/render/index.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.unsettled !== undefined, { timeout: 30_000 });

// The page decides its own size from the view box, so the window follows it
// rather than the other way round - otherwise a crop silently gets clipped.
const size = await page.evaluate(() => window.unsettled.size);
await page.setViewportSize(size);

const days = await page.evaluate(() => window.unsettled.days);
const frames = [];

async function shoot(day, coast) {
  await page.evaluate(([d, c]) => window.unsettled.draw(d, c), [day, coast]);
  await page.waitForTimeout(120);
  const buffer = await page.locator('canvas').screenshot({ type: 'png' });
  return { day, coast, png: PNG.sync.read(buffer), buffer };
}

for (let day = 0; day < days; day++) {
  frames.push(await shoot(day, 0));
  process.stdout.write(`\r  rendered day ${day + 1}/${days}`);
}

/**
 * The last second of the animation fades the coastline in over the final frame.
 *
 * Without it a viewer has to take the claim on trust, because a smooth field at
 * this resolution does not read as a recognisable map however long you stare at
 * it. The reveal is the evidence: same grid, same request, drawn on top.
 */
const reveal = [];
for (const alpha of [0.25, 0.5, 0.75, 1]) {
  reveal.push(await shoot(days - 1, alpha));
}
process.stdout.write('\n');

await browser.close();
server.close();

mkdirSync('docs', { recursive: true });

/**
 * The still is the last frame, and that is a measured choice rather than a
 * taste one.
 *
 * I originally used day five on the assumption it was the most readable as a
 * map, and it isn't. Scoring how well spread alone separates land cells from
 * sea cells - the chance a random land cell reads brighter than a random sea
 * one - gives 0.48 on day one, 0.83 on day five and 0.95 on day seven. Day five
 * looks like a smudge because a sixth of the coastline is genuinely still
 * missing at that lead time. The continent only finishes drawing itself at the
 * end of the week, which is also the point the picture is making.
 */
const hero = frames[frames.length - 1];
writeFileSync('docs/day7.png', hero.buffer);
console.log(`docs/day7.png — ${(statSync('docs/day7.png').size / 1e6).toFixed(2)} MB`);

writeFileSync('docs/day7-coast.png', reveal[reveal.length - 1].buffer);
console.log(`docs/day7-coast.png — ${(statSync('docs/day7-coast.png').size / 1e6).toFixed(2)} MB`);

/** Days at a readable pace, the reveal quickly, then a long look at the result. */
const sequence = [
  ...frames.map((f) => ({ frame: f, hold: HOLD })),
  ...reveal.map((f) => ({ frame: f, hold: 0.18 })),
  { frame: reveal[reveal.length - 1], hold: 2.4 },
];

writeGif();
writeVideo();

function writeGif() {
  const { width, height } = frames[0].png;
  // One palette across every frame, or the ramp shimmers between days and the
  // whole thing looks like a compression artefact instead of a measurement.
  const unique = [...frames, ...reveal];
  const merged = new Uint8Array(unique.reduce((n, f) => n + f.png.data.length, 0));
  let at = 0;
  for (const frame of unique) {
    merged.set(new Uint8Array(frame.png.data), at);
    at += frame.png.data.length;
  }

  const palette = quantize(merged, 256, { format: 'rgb565' });
  const encoder = GIFEncoder();
  for (const step of sequence) {
    encoder.writeFrame(
      applyPalette(new Uint8Array(step.frame.png.data), palette, 'rgb565'),
      width,
      height,
      { palette, delay: step.hold * 1000 },
    );
  }
  encoder.finish();

  const bytes = encoder.bytes();
  writeFileSync('docs/unsettled.gif', bytes);
  console.log(`docs/unsettled.gif — ${sequence.length} frames, ${(bytes.length / 1e6).toFixed(2)} MB`);
}

function writeVideo() {
  if (spawnSync('ffmpeg', ['-version']).error) {
    console.log('ffmpeg not on PATH — skipping the mp4');
    return;
  }

  const dir = 'docs/.frames';
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  let n = 0;
  for (const step of sequence) {
    // Video has no per-frame delay, so a held frame is simply written out as
    // many times as the frame rate needs.
    for (let i = 0; i < Math.max(1, Math.round(step.hold * FPS)); i++) {
      writeFileSync(join(dir, `f${String(n++).padStart(5, '0')}.png`), step.frame.buffer);
    }
  }

  const result = spawnSync('ffmpeg', [
    '-y', '-framerate', String(FPS),
    '-i', join(dir, 'f%05d.png'),
    '-c:v', 'libx264', '-crf', '18',
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    'docs/unsettled.mp4',
  ], { encoding: 'utf8' });

  rmSync(dir, { recursive: true, force: true });

  if (result.status !== 0) {
    console.log('ffmpeg failed:', String(result.stderr ?? '').slice(-300));
    return;
  }
  console.log(
    `docs/unsettled.mp4 — ${(n / FPS).toFixed(1)}s, ${(statSync('docs/unsettled.mp4').size / 1e6).toFixed(2)} MB`,
  );
}
