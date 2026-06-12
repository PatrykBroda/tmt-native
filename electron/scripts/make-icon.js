'use strict';
// node scripts/make-icon.js
// Uses playwright-core + Edge (built into Windows 11) to render assets/icon.svg → assets/icon.png + icon.ico
const { chromium } = require('playwright-core');
const path = require('path');
const fs   = require('fs');

function pngToIco(pngBuffer) {
  // Modern ICO: single 256x256 entry wrapping the raw PNG bytes
  const header = Buffer.alloc(6);
  header.writeUInt16LE(0, 0); // reserved
  header.writeUInt16LE(1, 2); // type: 1 = icon
  header.writeUInt16LE(1, 4); // image count
  const dataOffset = 6 + 16;
  const entry = Buffer.alloc(16);
  entry.writeUInt8(0,  0);  // width  (0 = 256)
  entry.writeUInt8(0,  1);  // height (0 = 256)
  entry.writeUInt8(0,  2);  // color count
  entry.writeUInt8(0,  3);  // reserved
  entry.writeUInt16LE(1,  4); // color planes
  entry.writeUInt16LE(32, 6); // bits per pixel
  entry.writeUInt32LE(pngBuffer.length, 8);  // data byte size
  entry.writeUInt32LE(dataOffset,        12); // offset to data
  return Buffer.concat([header, entry, pngBuffer]);
}

(async () => {
  const assetsDir = path.join(__dirname, '..', 'assets');
  const svgPath   = path.join(assetsDir, 'icon.svg');
  const pngPath   = path.join(assetsDir, 'icon.png');
  const icoPath   = path.join(assetsDir, 'icon.ico');

  const svgContent = fs.readFileSync(svgPath, 'utf8');

  console.log('Launching Edge to render SVG…');
  const browser = await chromium.launch({ channel: 'msedge', headless: true });
  const page    = await browser.newPage();
  await page.setViewportSize({ width: 256, height: 256 });

  const html = `<!DOCTYPE html><html><head>
    <style>*{margin:0;padding:0;}html,body{width:256px;height:256px;overflow:hidden;background:#000;}</style>
  </head><body>
    <img src="data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgContent)}"
         width="256" height="256" style="display:block;" />
  </body></html>`;

  await page.setContent(html);
  await page.waitForTimeout(800); // let SVG filters settle

  const pngBuf = await page.screenshot({ clip: { x: 0, y: 0, width: 256, height: 256 } });
  fs.writeFileSync(pngPath, pngBuf);
  console.log('✓  PNG written:', pngPath);

  const icoBuf = pngToIco(pngBuf);
  fs.writeFileSync(icoPath, icoBuf);
  console.log('✓  ICO written:', icoPath);

  await browser.close();
})().catch(err => { console.error('make-icon failed:', err.message); process.exit(1); });
