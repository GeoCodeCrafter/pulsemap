#!/usr/bin/env node
/**
 * Renders a config to a still, a looping mp4 and a gif.
 *
 *   node scripts/render.mjs configs/rivers-britain.json
 *   node scripts/render.mjs configs/quakes.json --width 1200 --frames 120
 *
 * The page is driven one frame at a time from here rather than left to animate
 * on its own, so the output is exact at any frame rate instead of being however
 * far the browser happened to get between screenshots. An earlier version
 * filmed a live animation and produced a stuttering four frames a second.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync, rmSync, statSync, existsSync } from 'node:fs';
import { basename, extname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const args = process.argv.slice(2);
const config = args.find((a) => !a.startsWith('--'));
if (!config || !existsSync(config)) {
  console.log('usage: node scripts/render.mjs <config.json> [--width N] [--frames N] [--fps N] [--still-only]');
  process.exit(1);
}

const flag = (name, fallback) => {
  const at = args.indexOf(`--${name}`);
  return at === -1 ? fallback : Number(args[at + 1]);
};

const name = basename(config, '.json');
const STILL_WIDTH = flag('still', 2400);
const LOOP_WIDTH = flag('width', 900);
const FRAMES = flag('frames', 100);
const FPS = flag('fps', 20);
const stillOnly = args.includes('--still-only');

const PORT = 5220;
const TYPES = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.json': 'application/json',
  '.geojson': 'application/json',
};

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
mkdirSync('docs', { recursive: true });

await shoot(STILL_WIDTH, async (page) => {
  const buffer = await page.locator('canvas').screenshot({ type: 'png' });
  writeFileSync(`docs/${name}.png`, buffer);
  report(`docs/${name}.png`);
});

if (!stillOnly) {
  const dir = `docs/.frames-${name}`;
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });

  await shoot(LOOP_WIDTH, async (page) => {
    const canvas = page.locator('canvas');
    for (let i = 0; i < FRAMES; i++) {
      // Never render t = 1: it is the same picture as t = 0, and including
      // both makes the loop hitch for exactly one frame.
      await page.evaluate((t) => window.pulsemap.draw(t), i / FRAMES);
      writeFileSync(`${dir}/f${String(i).padStart(4, '0')}.png`, await canvas.screenshot({ type: 'png' }));
      if (i % 20 === 0) process.stdout.write(`\r  ${i}/${FRAMES}`);
    }
    process.stdout.write(`\r  ${FRAMES}/${FRAMES} frames\n`);
  });

  // Two passes for the gif: a palette built from the actual frames, then the
  // mapping. One pass with a generic palette bands every colour ramp badly.
  ffmpeg(['-y', '-framerate', String(FPS), '-i', `${dir}/f%04d.png`,
    '-vf', 'palettegen=max_colors=160:stats_mode=diff', `${dir}/palette.png`]);
  ffmpeg(['-y', '-framerate', String(FPS), '-i', `${dir}/f%04d.png`, '-i', `${dir}/palette.png`,
    '-lavfi', '[0:v][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle',
    '-loop', '0', `docs/${name}.gif`]);
  ffmpeg(['-y', '-framerate', String(FPS), '-i', `${dir}/f%04d.png`,
    '-c:v', 'libx264', '-preset', 'slow', '-crf', '18',
    // H.264 with 4:2:0 chroma cannot encode an odd dimension, and x264's
    // complaint about it is a bare "invalid argument" with a zero-byte file.
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart', `docs/${name}-loop.mp4`]);

  rmSync(dir, { recursive: true, force: true });
  report(`docs/${name}.gif`);
  report(`docs/${name}-loop.mp4`);
}

await browser.close();
server.close();

async function shoot(width, work) {
  const page = await browser.newPage({ viewport: { width: 900, height: 700 } });
  page.on('pageerror', (error) => console.log('page error:', error.message));
  await page.goto(`http://localhost:${PORT}/render/index.html?config=${config}&w=${width}`, {
    waitUntil: 'networkidle',
  });
  await page.waitForFunction(() => window.pulsemap !== undefined, { timeout: 120_000 });
  await page.setViewportSize(await page.evaluate(() => window.pulsemap.size));
  await work(page);
  await page.close();
}

function ffmpeg(argv) {
  const result = spawnSync('ffmpeg', argv, { encoding: 'utf8' });
  if (result.status !== 0) {
    console.log('ffmpeg failed:', String(result.stderr ?? '').slice(-400));
    process.exit(1);
  }
}

function report(file) {
  console.log(`${file} — ${(statSync(file).size / 1e6).toFixed(1)} MB`);
}
