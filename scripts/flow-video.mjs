#!/usr/bin/env node
/**
 * Captures the particle renderer as a 60fps video.
 *
 * Frames go out as JPEG rather than PNG purely for disk: 720 lossless frames of
 * this size is most of a gigabyte, and the difference is invisible once x264
 * has been over it.
 *
 * Note this currently animates a synthetic wind field - see render/flow.js. It
 * is a look test, not a picture of any real weather.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync, rmSync, statSync, readdirSync } from 'node:fs';
import { extname, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { chromium } from '@playwright/test';

const PORT = 5212;
const FPS = 60;
/** Longer than feels necessary, to match the slower drift. */
const SECONDS = 16;
/** Steps run before recording, so frame one already has trails on it. */
const WARMUP = 420;

const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.json': 'application/json' };

const server = createServer(async (request, response) => {
  const path = decodeURIComponent((request.url ?? '/').split('?')[0]);
  const file = path === '/' ? 'render/flow.html' : path.replace(/^\/+/, '');
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
const page = await browser.newPage({ viewport: { width: 800, height: 600 } });
page.on('pageerror', (error) => console.log('page error:', error.message));
await page.goto(`http://localhost:${PORT}/render/flow.html`, { waitUntil: 'networkidle' });
await page.waitForFunction(() => window.flow !== undefined, { timeout: 30_000 });
await page.setViewportSize(await page.evaluate(() => window.flow.size));

await page.evaluate((n) => window.flow.run(n), WARMUP);

const dir = 'docs/.flow-frames';
rmSync(dir, { recursive: true, force: true });
mkdirSync(dir, { recursive: true });

const total = FPS * SECONDS;
const canvas = page.locator('canvas');

for (let i = 0; i < total; i++) {
  // One simulation step per output frame, so motion is smooth at 60fps rather
  // than the renderer running at its own pace and being sampled.
  await page.evaluate(() => window.flow.step());
  const buffer = await canvas.screenshot({ type: 'jpeg', quality: 95 });
  writeFileSync(join(dir, `f${String(i).padStart(5, '0')}.jpg`), buffer);
  if (i % 60 === 0) process.stdout.write(`\r  ${i}/${total} frames`);
}
process.stdout.write(`\r  ${total}/${total} frames\n`);

await browser.close();
server.close();

const written = readdirSync(dir).filter((f) => f.endsWith('.jpg')).length;
console.log(`  ${written} frames on disk`);
if (written === 0) {
  console.log('nothing captured — leaving ' + dir + ' alone');
  process.exit(1);
}

if (spawnSync('ffmpeg', ['-version']).error) {
  console.log('ffmpeg not on PATH — frames left in ' + dir);
  process.exit(1);
}

const result = spawnSync(
  'ffmpeg',
  [
    '-y', '-framerate', String(FPS),
    '-i', `${dir}/f%05d.jpg`,
    '-c:v', 'libx264', // 4K of high-entropy particle texture: 'slow' at this size costs far more
    // time than the extra quality is worth, and a low CRF matters more.
    '-preset', 'medium', '-crf', '16',
    // Belt and braces: the canvas is sized even, but an odd frame here costs a
    // whole re-capture to discover.
    '-vf', 'scale=trunc(iw/2)*2:trunc(ih/2)*2',
    '-pix_fmt', 'yuv420p', '-movflags', '+faststart',
    'docs/flow.mp4',
  ],
  { encoding: 'utf8' },
);

if (result.status !== 0) {
  console.log('ffmpeg failed:', String(result.stderr ?? '').slice(-400));
  console.log('frames kept in ' + dir);
  process.exit(1);
}

rmSync(dir, { recursive: true, force: true });
console.log(
  `docs/flow.mp4 — ${SECONDS}s at ${FPS}fps, ${(statSync('docs/flow.mp4').size / 1e6).toFixed(2)} MB`,
);
