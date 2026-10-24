'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const runners = require('../src/runners');

async function tool(file, executable = true) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, '#!/bin/sh\n'); await fs.chmod(file, executable ? 0o755 : 0o644);
}

test('Proton and GE-Proton from every Steam folder, then the system Wine; each one once, only runnable ones', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'xd-runners-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  const steam = path.join(home, '.local', 'share', 'Steam');
  await tool(path.join(steam, 'steamapps', 'common', 'Proton 9.0', 'proton'));
  await tool(path.join(steam, 'compatibilitytools.d', 'GE-Proton9-20', 'proton'));
  await tool(path.join(steam, 'compatibilitytools.d', 'Broken', 'proton'), false);
  await fs.mkdir(path.join(home, '.steam'), { recursive: true });
  await fs.symlink(steam, path.join(home, '.steam', 'steam'));
  await tool(path.join(home, 'bin', 'wine'));
  const found = await runners.detect({ home, pathEnv: [path.join(home, 'nowhere'), path.join(home, 'bin')].join(path.delimiter) });
  assert.deepEqual(found.map(item => item.label), ['Proton 9.0', 'GE-Proton9-20', 'System Wine']);
  assert.deepEqual(found.map(item => item.type), ['proton', 'proton', 'wine']);
  assert.equal(found[2].path, path.join(home, 'bin', 'wine'));
  assert.equal(await runners.steamRoot(home), path.join(home, '.steam', 'steam'));
});

test('without Steam the default root is ~/.steam/steam; a runner is Proton by its file name', async t => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), 'xd-runners-'));
  t.after(() => fs.rm(home, { recursive: true, force: true }));
  assert.equal(await runners.steamRoot(home), path.join(home, '.steam', 'steam'));
  assert.deepEqual(await runners.detect({ home, pathEnv: '' }), []);
  assert.deepEqual(runners.steamRoots('/h'), ['/h/.steam/steam', '/h/.local/share/Steam', '/h/.var/app/com.valvesoftware.Steam/data/Steam']);
  assert.equal(runners.isProton('/x/proton'), true);
  assert.equal(runners.isProton('/x/wine'), false);
});
