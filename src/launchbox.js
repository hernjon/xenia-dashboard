'use strict';
// LaunchBox Games Database as a cover source. LaunchBox publishes its whole database as one ZIP (Metadata.zip,
// ~100 MB, mostly one huge XML). It has no API, so this reads that file once, keeps only the Xbox 360 games and
// their box-art entries in a small index on disk, and fetches the pictures themselves from LaunchBox's image host.
// Nothing here trusts the file: names are only ever compared as text, and a picture's address is built from a
// fixed host plus a file name that has to be in the index.
const fs = require('node:fs/promises');
const { createReadStream } = require('node:fs');
const zlib = require('node:zlib');
const readline = require('node:readline');
const path = require('node:path');
const crypto = require('node:crypto');
const covers = require('./covers');

const ZIP_URL = 'https://gamesdb.launchbox-app.com/Metadata.zip';
const IMAGE_BASE = 'https://images.launchbox-app.com/';
const PLATFORM = 'Microsoft Xbox 360';
const ENTRY = 'Metadata.xml';
const MAX_ZIP = 300 * 1024 * 1024, MAX_XML = 2 * 1024 * 1024 * 1024, MAX_IMAGE = 12 * 1024 * 1024, MAX_PER_GAME = 24;
// In the order they are offered. The label is what the user sees.
const TYPES = new Map([['Box - Front', 'Front'], ['Box - 3D', '3D box'], ['Fanart - Box - Front', 'Fan art'], ['Box - Front - Reconstructed', 'Front (restored)']]);
const FILE_NAME = /^[A-Za-z0-9_-]{1,80}\.(?:jpg|png)$/;
const clean = (text, limit) => String(text).replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/[\u0000-\u001f\u007f]/g, '').slice(0, limit);

// ------------------------------------------------------------ the ZIP: find Metadata.xml and stream it
async function locate(file) {
  const handle = await fs.open(file, 'r');
  try {
    const { size } = await handle.stat();
    if (size > MAX_ZIP || size < 100) throw Error('The LaunchBox download has an unexpected size');
    const tailLength = Math.min(size, 70000), tail = Buffer.alloc(tailLength);
    await handle.read(tail, 0, tailLength, size - tailLength);
    const end = tail.lastIndexOf(Buffer.from([0x50, 0x4b, 0x05, 0x06]));
    if (end < 0) throw Error('The LaunchBox download is not a ZIP file');
    const count = tail.readUInt16LE(end + 10), directorySize = tail.readUInt32LE(end + 12), directoryAt = tail.readUInt32LE(end + 16);
    if (count === 0xffff || directoryAt === 0xffffffff || directoryAt + directorySize > size || directorySize > 1024 * 1024) throw Error('The LaunchBox ZIP is not in a supported layout');
    const directory = Buffer.alloc(directorySize);
    await handle.read(directory, 0, directorySize, directoryAt);
    for (let at = 0, seen = 0; seen < count && at + 46 <= directory.length; seen++) {
      if (directory.readUInt32LE(at) !== 0x02014b50) break;
      const method = directory.readUInt16LE(at + 10), compressed = directory.readUInt32LE(at + 20), original = directory.readUInt32LE(at + 24);
      const nameLength = directory.readUInt16LE(at + 28), extraLength = directory.readUInt16LE(at + 30), commentLength = directory.readUInt16LE(at + 32), headerAt = directory.readUInt32LE(at + 42);
      const name = directory.toString('latin1', at + 46, at + 46 + nameLength);
      at += 46 + nameLength + extraLength + commentLength;
      if (name !== ENTRY) continue;
      if (method !== 8) throw Error('The LaunchBox ZIP uses an unsupported compression');
      if (compressed === 0xffffffff || original === 0xffffffff || original > MAX_XML) throw Error('The LaunchBox data is larger than expected');
      const local = Buffer.alloc(30);
      await handle.read(local, 0, 30, headerAt);
      if (local.readUInt32LE(0) !== 0x04034b50) throw Error('The LaunchBox ZIP is damaged');
      const start = headerAt + 30 + local.readUInt16LE(26) + local.readUInt16LE(28);
      if (start + compressed > size) throw Error('The LaunchBox ZIP is damaged');
      return { start, end: start + compressed - 1, original };
    }
    throw Error('The LaunchBox ZIP has no game data');
  } finally { await handle.close(); }
}
// The XML is written one tag per line, so lines are enough; every limit is checked on the way.
async function* lines(file) {
  const entry = await locate(file), inflate = zlib.createInflateRaw();
  let produced = 0;
  inflate.on('data', chunk => { produced += chunk.length; if (produced > Math.min(entry.original + 1024, MAX_XML)) inflate.destroy(Error('The LaunchBox data is larger than announced')); });
  createReadStream(file, { start: entry.start, end: entry.end }).on('error', error => inflate.destroy(error)).pipe(inflate);
  yield* readline.createInterface({ input: inflate, crlfDelay: Infinity });
}

// ------------------------------------------------------------ the index
// Keeps only Xbox 360 games that have at least one usable picture: [{ id, name, images: [{ file, type, region }] }]
// One pass over the database gives two indexes: the Xbox 360 games (for Xenia games, as always) and every platform's
// games with a few pictures each (for native games: recomps and PC ports can be any console's game).
const MAX_PER_GAME_ALL = 4;
async function buildIndexes(source) {
  const games = new Map(), pictures = new Map();
  let game = null, picture = null;
  for await (const raw of source) {
    const line = raw.trim();
    if (game) {
      if (line === '</Game>') { if (game.DatabaseID && game.Name && game.Platform) games.set(game.DatabaseID, { name: clean(game.Name, 120), platform: clean(game.Platform, 80) }); game = null; continue; }
      const found = /^<(Name|DatabaseID|Platform)>(.*)<\/\1>$/.exec(line); if (found) game[found[1]] = found[2];
    } else if (picture) {
      if (line === '</GameImage>') {
        if (picture.DatabaseID && TYPES.has(picture.Type) && FILE_NAME.test(picture.FileName || '')) { const list = pictures.get(picture.DatabaseID) || []; list.push({ file: picture.FileName, type: picture.Type, region: clean(picture.Region || '', 40) }); pictures.set(picture.DatabaseID, list); }
        picture = null; continue;
      }
      const found = /^<(FileName|Type|Region|DatabaseID)>(.*)<\/\1>$/.exec(line); if (found) picture[found[1]] = found[2];
    } else if (line === '<Game>') game = {};
    else if (line === '<GameImage>') picture = {};
  }
  const order = [...TYPES.keys()], regionRank = region => region === 'North America' ? 0 : /World|Europe|United States/.test(region) ? 1 : 2;
  const xbox360 = [], all = [];
  for (const [id, { name, platform }] of games) {
    const images = (pictures.get(id) || []).sort((a, b) => order.indexOf(a.type) - order.indexOf(b.type) || regionRank(a.region) - regionRank(b.region));
    if (!images.length) continue;
    if (platform === PLATFORM) xbox360.push({ id, name, images: images.slice(0, MAX_PER_GAME) });
    all.push({ id, name, platform, images: images.slice(0, MAX_PER_GAME_ALL) });
  }
  return { xbox360: xbox360.sort((a, b) => a.name.localeCompare(b.name)), all: all.sort((a, b) => a.name.localeCompare(b.name) || a.platform.localeCompare(b.platform)) };
}
async function buildIndex(source) { return (await buildIndexes(source)).xbox360; }

const INDEXES = new Set(['xbox360', 'all']);
const indexFile = (directory, name) => { if (!INDEXES.has(name)) throw Error('Unknown LaunchBox index'); return path.join(directory, `${name}.json`); };
async function writeIndex(directory, index, now = Date.now(), name = 'xbox360') {
  await fs.mkdir(directory, { recursive: true });
  const file = indexFile(directory, name), temp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  await fs.writeFile(temp, JSON.stringify({ built: now, games: index }), { mode: 0o600, flag: 'wx' });
  await fs.rename(temp, file);
}
async function readIndex(directory, name = 'xbox360') {
  let data;
  const file = indexFile(directory, name), all = name === 'all';
  try { data = JSON.parse(await fs.readFile(file, 'utf8')); } catch (error) { if (error.code === 'ENOENT' || error instanceof SyntaxError) return null; throw error; }
  const games = Array.isArray(data?.games) ? data.games.filter(entry => typeof entry?.id === 'string' && /^\d{1,10}$/.test(entry.id) && typeof entry.name === 'string' && Array.isArray(entry.images) && (!all || (typeof entry.platform === 'string' && entry.platform))).map(entry => ({ id: entry.id, name: entry.name.slice(0, 120), ...(all ? { platform: entry.platform.slice(0, 80) } : {}), images: entry.images.filter(image => FILE_NAME.test(image?.file || '') && TYPES.has(image.type)).map(image => ({ file: image.file, type: image.type, region: String(image.region || '').slice(0, 40) })) })).filter(entry => entry.images.length) : [];
  return { built: Number.isFinite(data?.built) ? data.built : 0, games };
}

// ------------------------------------------------------------ download the database (one fixed address, no redirects)
async function download(file, { fetcher, onProgress = () => {}, timeoutMs = 600000 }) {
  const response = await fetcher(ZIP_URL, { signal: AbortSignal.timeout(timeoutMs) });
  if (!response.ok) throw Error(`LaunchBox answered ${response.status}. Try again later.`);
  const total = Number(response.headers.get('content-length')) || 0;
  if (!total || total > MAX_ZIP) throw Error('The LaunchBox download has an unexpected size');
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${crypto.randomBytes(8).toString('hex')}.tmp`, handle = await fs.open(temp, 'wx', 0o600);
  let received = 0, reported = 0;
  try {
    for await (const chunk of response.body) {
      received += chunk.length;
      if (received > total) throw Error('The download is larger than announced');
      await handle.write(chunk);
      if (received - reported >= 512 * 1024) { reported = received; onProgress({ received, total }); }
    }
    await handle.close();
    if (received !== total) throw Error('The download was cut short');
    await fs.rename(temp, file);
  } catch (error) { await handle.close().catch(() => {}); await fs.unlink(temp).catch(() => {}); throw error; }
}
// Downloads Metadata.zip, reduces it to the two indexes, stores them, and throws the big file away.
async function prepare(directory, { fetcher, onProgress, now }) {
  const zip = path.join(directory, 'Metadata.zip');
  try {
    await download(zip, { fetcher, onProgress });
    const { xbox360, all } = await buildIndexes(lines(zip));
    if (!xbox360.length) throw Error('LaunchBox data had no Xbox 360 games');
    await writeIndex(directory, all, now, 'all');
    await writeIndex(directory, xbox360, now);
    return xbox360;
  } finally { await fs.unlink(zip).catch(() => {}); }
}

// ------------------------------------------------------------ use
const plain = text => String(text || '').normalize('NFKD').replace(/[\u0300-\u036f]/g, '').toLowerCase().replace(/[^a-z0-9]/g, '');
// For unattended use: only a game whose whole name equals the title counts (the one with most pictures wins a tie),
// and its best picture is the first plain front cover, falling back to whatever the index lists first.
function exact(index, title) {
  const wanted = plain(title); if (!wanted) return null;
  const same = index.filter(entry => plain(entry.name) === wanted).sort((a, b) => b.images.length - a.images.length);
  const game = same[0]; if (!game) return null;
  return { game, picture: game.images.find(image => image.type === 'Box - Front') || game.images[0] };
}
// Games whose name resembles the title, best first (the same matcher the other catalogue uses).
function search(index, title) {
  const byId = new Map(index.map(entry => [entry.id, entry]));
  return covers.matches(String(title || ''), index.map(entry => ({ id: entry.id, title: entry.name }))).map(found => ({ id: found.id, title: found.title, ...(byId.get(found.id).platform ? { platform: byId.get(found.id).platform } : {}), pictures: byId.get(found.id).images.length }));
}
function pictures(index, gameId) {
  const game = index.find(entry => entry.id === gameId);
  if (!game) throw Error('Unknown LaunchBox game');
  return game.images.map(image => ({ file: image.file, label: `${TYPES.get(image.type)}${image.region ? ` · ${image.region}` : ''}`, type: image.type }));
}
function imageUrl(index, gameId, file) {
  if (!index.find(entry => entry.id === gameId)?.images.some(image => image.file === file)) throw Error('Unknown LaunchBox picture');
  return `${IMAGE_BASE}${file}`;
}
async function fetchImage(index, gameId, file, fetcher) {
  const bytes = await covers.request(imageUrl(index, gameId, file), fetcher, MAX_IMAGE);
  const jpeg = bytes.length > 12 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff;
  const png = bytes.length > 12 && bytes.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
  if (!jpeg && !png) throw Error('LaunchBox did not return a picture');
  return { bytes, mime: jpeg ? 'image/jpeg' : 'image/png' };
}
module.exports = { ZIP_URL, IMAGE_BASE, PLATFORM, TYPES, locate, lines, buildIndex, buildIndexes, writeIndex, readIndex, download, prepare, exact, search, pictures, imageUrl, fetchImage };
