#!/usr/bin/env node
/**
 * Makes a GIF from the rendered mp4.
 *
 * GIF is a bad container for this. Dense moving texture is close to worst case
 * for it - a straight 16s conversion at 1000px came out at 108 MB, against 52
 * for the whole thing as 1080p H.264. So this deliberately gives up most of
 * what the video has: 8 seconds instead of 16, 15fps instead of 60, 720px
 * instead of 3840, and 128 colours.
 *
 * Post the mp4 wherever the site allows it. This exists for the places that
 * still do not.
 */

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const SECONDS = 8;
const FPS = 15;
const WIDTH = 720;
const COLORS = 128;

const SOURCE = 'docs/flow.mp4';
const OUT = 'docs/flow.gif';

if (spawnSync('ffmpeg', ['-version']).error) {
  console.log('ffmpeg not on PATH');
  process.exit(1);
}

const work = mkdtempSync(join(tmpdir(), 'flow-gif-'));
const palette = join(work, 'palette.png');
const chain = `fps=${FPS},scale=${WIDTH}:-1:flags=lanczos`;

// Two passes: build a palette from the actual frames, then map to it. One pass
// with a generic palette bands the colour ramp badly.
run(['-y', '-t', String(SECONDS), '-i', SOURCE,
  '-vf', `${chain},palettegen=max_colors=${COLORS}:stats_mode=diff`, palette]);

run(['-y', '-t', String(SECONDS), '-i', SOURCE, '-i', palette,
  '-lavfi', `${chain}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle`,
  OUT]);

rmSync(work, { recursive: true, force: true });
console.log(`${OUT} — ${SECONDS}s at ${FPS}fps, ${(statSync(OUT).size / 1e6).toFixed(1)} MB`);

function run(args) {
  const result = spawnSync('ffmpeg', args, { encoding: 'utf8' });
  if (result.status !== 0) {
    console.log('ffmpeg failed:', String(result.stderr ?? '').slice(-400));
    process.exit(1);
  }
}
