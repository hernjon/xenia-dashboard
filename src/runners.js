'use strict';
// Linux only: what can run a Windows .exe game. Valve's Proton and community builds (GE-Proton) live in Steam's
// folders; Wine is whatever `wine` is on PATH. Looked up when the Run with list opens, never at start-up.
const fs = require('node:fs');
const path = require('node:path');

const steamRoots = home => [path.join(home, '.steam', 'steam'), path.join(home, '.local', 'share', 'Steam'), path.join(home, '.var', 'app', 'com.valvesoftware.Steam', 'data', 'Steam')];
const isProton = file => path.basename(String(file || '')) === 'proton';
const runnable = async (file, fsp) => { try { await fsp.access(file, fs.constants.X_OK); return (await fsp.stat(file)).isFile(); } catch { return false; } };
const folders = async (directory, fsp) => { try { return (await fsp.readdir(directory, { withFileTypes: true })).filter(entry => entry.isDirectory() || entry.isSymbolicLink()).map(entry => entry.name); } catch { return []; } };

// The Steam folder Proton is told about. A missing Steam still gets the usual path; Proton then sets it up itself.
async function steamRoot(home, fsp = fs.promises) {
  for (const root of steamRoots(home)) { try { await fsp.access(root); return root; } catch { /* next */ } }
  return steamRoots(home)[0];
}

// Newest-looking Proton first (names sort that way), then the system Wine. The same file reached twice is listed once.
async function detect({ home, pathEnv = '', fsp = fs.promises }) {
  const seen = new Set(), protons = [], wines = [];
  const add = async (list, item) => {
    if (!(await runnable(item.path, fsp))) return;
    let real = item.path; try { real = await fsp.realpath(item.path); } catch { /* keep the path as it is */ }
    if (seen.has(real)) return; seen.add(real); list.push(item);
  };
  for (const root of steamRoots(home)) {
    const common = path.join(root, 'steamapps', 'common'), tools = path.join(root, 'compatibilitytools.d');
    for (const name of (await folders(common, fsp)).filter(name => name.startsWith('Proton'))) await add(protons, { label: name, path: path.join(common, name, 'proton'), type: 'proton' });
    for (const name of await folders(tools, fsp)) await add(protons, { label: name, path: path.join(tools, name, 'proton'), type: 'proton' });
  }
  for (const directory of String(pathEnv).split(path.delimiter).filter(Boolean)) await add(wines, { label: 'System Wine', path: path.join(directory, 'wine'), type: 'wine' });
  protons.sort((a, b) => b.label.localeCompare(a.label));
  return [...protons, ...wines.slice(0, 1)];
}

module.exports = { steamRoots, steamRoot, isProton, detect };
