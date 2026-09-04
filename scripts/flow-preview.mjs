#!/usr/bin/env node
/**
 * Captures one still of the particle renderer, to settle the look before any
 * API quota is spent on real wind data.
 */

import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { mkdirSync, writeFileSync, statSync } from 'node:fs';
import { extname } from 'node:path';
import { chromium } from '@playwright/test';

const PORT = 5211;
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

// Let the trails build up to a steady state before looking at it.
await page.evaluate(() => window.flow.run(260));

mkdirSync('docs', { recursive: true });
const buffer = await page.locator('canvas').screenshot({ type: 'png' });
writeFileSync('docs/flow-preview.png', buffer);
console.log(`docs/flow-preview.png — ${(statSync('docs/flow-preview.png').size / 1e6).toFixed(2)} MB`);

await browser.close();
server.close();
