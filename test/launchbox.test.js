'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const zlib = require('node:zlib');
const launchbox = require('../src/launchbox');

const temp = async t => { const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'xd-lb-')); t.after(() => fs.rm(dir, { recursive: true, force: true })); return dir; };
const { makeZip: zip } = require('./helpers/make-zip');
const game = (id, name, platform, overview = 'A game.\nWith two lines.') => `  <Game>\n    <Name>${name}</Name>\n    <Overview>${overview}</Overview>\n    <DatabaseID>${id}</DatabaseID>\n    <Platform>${platform}</Platform>\n  </Game>\n`;
const picture = (id, file, type, region = 'North America') => `  <GameImage>\n    <DatabaseID>${id}</DatabaseID>\n    <FileName>${file}</FileName>\n    <Type>${type}</Type>\n    <Region>${region}</Region>\n  </GameImage>\n`;
const XML = '<?xml version="1.0"?>\n<LaunchBox>\n' + game('7481', 'Gears of War', 'Microsoft Xbox 360') + game('1', 'Gears of War', 'Microsoft Windows') + game('2', 'Banjo &amp; Kazooie', 'Microsoft Xbox 360') + game('3', 'No Pictures', 'Microsoft Xbox 360', 'x &lt;Platform&gt;Microsoft Xbox 360&lt;/Platform&gt;')
  + picture('7481', 'bbbb-3d.png', 'Box - 3D') + picture('7481', 'aaaa-eu.jpg', 'Box - Front', 'Europe') + picture('7481', 'aaaa-na.jpg', 'Box - Front') + picture('7481', 'cccc.jpg', 'Box - Back') + picture('7481', 'bad name.jpg', 'Box - Front') + picture('7481', '../escape.jpg', 'Box - Front') + picture('7481', 'x.gif', 'Box - Front')
  + picture('1', 'windows.jpg', 'Box - Front') + picture('2', 'banjo.jpg', 'Fanart - Box - Front') + picture('9', 'orphan.jpg', 'Box - Front') + '</LaunchBox>\n';

test('only Xbox 360 games with a usable box picture reach the index, best picture first', async t => {
  const dir = await temp(t), file = path.join(dir, 'Metadata.zip'); await fs.writeFile(file, zip([['Mame.xml', '<x/>'], ['Metadata.xml', XML]]));
  const index = await launchbox.buildIndex(launchbox.lines(file));
  assert.deepEqual(index.map(entry => entry.name), ['Banjo & Kazooie', 'Gears of War'], 'other platforms, games without pictures and orphans are left out; entities are decoded');
  assert.deepEqual(index[1].images.map(image => [image.file, image.type, image.region]), [['aaaa-na.jpg', 'Box - Front', 'North America'], ['aaaa-eu.jpg', 'Box - Front', 'Europe'], ['bbbb-3d.png', 'Box - 3D', 'North America']], 'Front before 3D, home region first; backs and unsafe names dropped');
});
test('the same pass keeps every platform for native games: name, platform and at most four pictures, fronts first', async t => {
  const dir = await temp(t), file = path.join(dir, 'Metadata.zip');
  const n64 = game('500', 'The Legend of Zelda: Majora&apos;s Mask', 'Nintendo 64') + ['a', 'b', 'c'].map(name => picture('500', `${name}-3d.png`, 'Box - 3D')).join('') + picture('500', 'z-fan.jpg', 'Fanart - Box - Front') + picture('500', 'front.jpg', 'Box - Front', 'Japan') + picture('500', 'back.jpg', 'Box - Back');
  await fs.writeFile(file, zip([['Metadata.xml', XML.replace('</LaunchBox>', n64 + '</LaunchBox>')]]));
  const { xbox360, all } = await launchbox.buildIndexes(launchbox.lines(file));
  assert.deepEqual(xbox360, await launchbox.buildIndex(launchbox.lines(file)), 'the Xbox 360 index is what it always was');
  assert.deepEqual(all.map(entry => [entry.name, entry.platform]), [['Banjo & Kazooie', 'Microsoft Xbox 360'], ['Gears of War', 'Microsoft Windows'], ['Gears of War', 'Microsoft Xbox 360'], ["The Legend of Zelda: Majora's Mask", 'Nintendo 64']]);
  const zelda = all.at(-1);
  assert.equal(zelda.images.length, 4);
  assert.equal(zelda.images[0].file, 'front.jpg', 'a front cover first, whatever its region');
  assert.equal(await launchbox.readIndex(dir, 'all'), null);
  await launchbox.writeIndex(dir, all, 9, 'all');
  const back = await launchbox.readIndex(dir, 'all');
  assert.equal(back.built, 9); assert.equal(back.games.at(-1).platform, 'Nintendo 64');
  await fs.writeFile(path.join(dir, 'all.json'), JSON.stringify({ built: 1, games: [{ id: '5', name: 'No platform', images: [{ file: 'a.jpg', type: 'Box - Front' }] }] }));
  assert.deepEqual((await launchbox.readIndex(dir, 'all')).games, [], 'an entry without a platform is dropped');
  assert.deepEqual(launchbox.search(back.games, 'Majoras Mask').map(found => [found.id, found.platform]), [['500', 'Nintendo 64']]);
  await assert.rejects(launchbox.readIndex(dir, '../x'), /Unknown LaunchBox index/);
});
test('the ZIP reader refuses what it cannot read safely', async t => {
  const dir = await temp(t), write = async (name, bytes) => { const file = path.join(dir, name); await fs.writeFile(file, bytes); return file; };
  await assert.rejects(launchbox.locate(await write('nozip', Buffer.alloc(500, 1))), /not a ZIP/);
  await assert.rejects(launchbox.locate(await write('tiny', Buffer.alloc(10))), /unexpected size/);
  await assert.rejects(launchbox.locate(await write('other', zip([['Other.xml', '<x/>']]))), /no game data/);
  await assert.rejects(launchbox.locate(await write('stored', zip([['Metadata.xml', XML]], { method: 0 }))), /unsupported compression/);
  const lying = zip([['Metadata.xml', XML]]); const at = lying.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); lying.writeUInt32LE(5, at + 24);
  await assert.rejects(launchbox.buildIndex(launchbox.lines(await write('lying', lying))), /larger than announced/);
});
test('the index is stored, read back and sanitised', async t => {
  const dir = await temp(t);
  assert.equal(await launchbox.readIndex(dir), null);
  await launchbox.writeIndex(dir, [{ id: '7481', name: 'Gears of War', images: [{ file: 'a.jpg', type: 'Box - Front', region: 'North America' }] }], 1700000000000);
  const back = await launchbox.readIndex(dir); assert.equal(back.built, 1700000000000); assert.equal(back.games[0].name, 'Gears of War');
  await fs.writeFile(path.join(dir, 'xbox360.json'), JSON.stringify({ built: 'x', games: [{ id: '../1', name: 'x', images: [] }, { id: '5', name: 'Ok', images: [{ file: '../../etc/passwd', type: 'Box - Front' }, { file: 'fine.png', type: 'Box - 3D', region: 5 }] }, null, 7] }));
  const bad = await launchbox.readIndex(dir); assert.equal(bad.built, 0); assert.deepEqual(bad.games.map(entry => [entry.id, entry.images.map(image => image.file)]), [['5', ['fine.png']]]);
  await fs.writeFile(path.join(dir, 'xbox360.json'), '{ not json'); assert.equal(await launchbox.readIndex(dir), null);
});
test('searching finds the game by name and its pictures are labelled for a person', () => {
  const index = [{ id: '7481', name: 'Gears of War', images: [{ file: 'a.jpg', type: 'Box - Front', region: 'North America' }, { file: 'b.png', type: 'Box - 3D', region: '' }] }, { id: '2', name: 'Banjo-Kazooie', images: [{ file: 'c.jpg', type: 'Fanart - Box - Front', region: 'Europe' }] }];
  assert.deepEqual(launchbox.search(index, 'Gears of War').map(found => [found.id, found.pictures]), [['7481', 2]]);
  assert.deepEqual(launchbox.search(index, ''), []);
  assert.deepEqual(launchbox.pictures(index, '7481').map(item => [item.file, item.label]), [['a.jpg', 'Front · North America'], ['b.png', '3D box']]);
  assert.throws(() => launchbox.pictures(index, '999'), /Unknown LaunchBox game/);
  assert.equal(launchbox.imageUrl(index, '7481', 'b.png'), 'https://images.launchbox-app.com/b.png');
  for (const [id, file] of [['7481', 'c.jpg'], ['2', 'a.jpg'], ['7481', '../x.png'], ['7481', 'https://evil.example/a.jpg']]) assert.throws(() => launchbox.imageUrl(index, id, file), /Unknown LaunchBox picture/);
});
test('pictures are fetched from the fixed host and must really be JPEG or PNG', async () => {
  const index = [{ id: '1', name: 'G', images: [{ file: 'a.jpg', type: 'Box - Front', region: '' }] }], seen = [];
  const answer = bytes => async (url, init) => { seen.push([url, init.redirect]); return new Response(bytes); };
  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(30)]), png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(30)]);
  assert.equal((await launchbox.fetchImage(index, '1', 'a.jpg', answer(jpeg))).mime, 'image/jpeg'); assert.equal((await launchbox.fetchImage(index, '1', 'a.jpg', answer(png))).mime, 'image/png');
  assert.deepEqual(seen[0], ['https://images.launchbox-app.com/a.jpg', 'error']);
  await assert.rejects(launchbox.fetchImage(index, '1', 'a.jpg', answer(Buffer.from('<html>captcha</html>' + ' '.repeat(40)))), /did not return a picture/);
  await assert.rejects(launchbox.fetchImage(index, '1', 'a.jpg', async () => new Response('no', { status: 500 })), /returned 500/);
});
test('preparing downloads, indexes and then deletes the big file', async t => {
  const dir = await temp(t), body = zip([['Metadata.xml', XML]]), progress = [];
  const fetcher = async url => { assert.equal(url, launchbox.ZIP_URL); return { ok: true, status: 200, headers: { get: name => name === 'content-length' ? String(body.length) : null }, body: (async function* () { for (let at = 0; at < body.length; at += 100) yield body.subarray(at, at + 100); })() }; };
  const index = await launchbox.prepare(dir, { fetcher, onProgress: item => progress.push(item), now: 5 });
  assert.equal(index.length, 2); assert.equal((await launchbox.readIndex(dir)).built, 5);
  assert.deepEqual((await fs.readdir(dir)).sort(), ['all.json', 'xbox360.json'], 'both indexes stay; the ZIP and scratch files are gone');
  assert.deepEqual((await launchbox.readIndex(dir, 'all')).games.map(entry => entry.platform).sort(), ['Microsoft Windows', 'Microsoft Xbox 360', 'Microsoft Xbox 360']);
  for (const [name, fetch, pattern] of [
    ['cut', async () => ({ ok: true, headers: { get: () => String(body.length + 50) }, body: (async function* () { yield body; })() }), /cut short/],
    ['long', async () => ({ ok: true, headers: { get: () => '10' }, body: (async function* () { yield body; })() }), /larger than announced/],
    ['redirect', async () => ({ ok: false, status: 302, headers: { get: () => null }, body: null }), /answered 302/],
    ['nolength', async () => ({ ok: true, headers: { get: () => null }, body: (async function* () { yield body; })() }), /unexpected size/],
    ['empty', async () => { const empty = zip([['Metadata.xml', '<LaunchBox></LaunchBox>']]); return { ok: true, headers: { get: () => String(empty.length) }, body: (async function* () { yield empty; })() }; }, /no Xbox 360 games/]
  ]) { const sub = path.join(dir, name); await assert.rejects(launchbox.prepare(sub, { fetcher: fetch }), pattern, name); assert.deepEqual(await fs.readdir(sub).catch(() => []), [], `${name}: nothing left behind`); }
});

test('unattended matching accepts only a whole-name match and picks the plain front cover', () => {
  const image = (file, type) => ({ file, type, region: '' });
  const index = [{ id: '1', name: 'Halo 3', images: [image('a.png', 'Box - 3D'), image('b.jpg', 'Box - Front')] }, { id: '2', name: 'Halo 3: ODST', images: [image('c.jpg', 'Box - Front')] }, { id: '3', name: 'Halo 3', images: [image('d.jpg', 'Box - Front')] }, { id: '4', name: 'Pi\u00f1ata', images: [image('e.png', 'Fanart - Box - Front')] }];
  const found = launchbox.exact(index, 'halo-3'); assert.deepEqual([found.game.id, found.picture.file], ['1', 'b.jpg'], 'more pictures wins, plain front before 3D');
  assert.equal(launchbox.exact(index, 'Halo'), null, 'a partial name is not a match'); assert.equal(launchbox.exact(index, ''), null);
  assert.equal(launchbox.exact(index, 'Pinata').picture.file, 'e.png', 'accents are ignored; any picture when there is no plain front');
});
