/*
 * Builds the online KiCad symbol library the web app serves at ./kicad/:
 *
 *   kicad/index.json        every part (name, library, description, keywords…)
 *   kicad/d/<Lib>/<n>.json  one drawing (all its units), shared by every part derived from it
 *   kicad/LICENSE.md        the KiCad libraries' licence and attribution
 *
 * Usage: npx vite-node scripts/build-kicad-library.ts [kicad-symbols checkout]
 * Without a checkout, the pinned release is cloned into ~/.cache/nodal-kicad.
 * Output goes to kicad-library/ (git-ignored; deploy-web.sh copies it).
 */
import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { readKicadLibrary } from '../src/io/kicadSymbols';
import { KICAD_FORMAT, kicadGroup, type KicadIndex } from '../src/model/kicadLibrary';

const TAG = '10.0.8';
const REPO = 'https://gitlab.com/kicad/libraries/kicad-symbols.git';

function source(): string {
  const given = process.argv[2];
  if (given) return resolve(given);
  const dir = join(homedir(), '.cache', 'nodal-kicad', TAG);
  if (!existsSync(join(dir, 'LICENSE.md'))) {
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(dir, { recursive: true });
    console.log(`Cloning kicad-symbols ${TAG}…`);
    execFileSync('git', ['clone', '-q', '--depth', '1', '--branch', TAG, REPO, dir], { stdio: 'inherit' });
  }
  return dir;
}

const src = source();
const out = resolve('kicad-library');
rmSync(out, { recursive: true, force: true });
mkdirSync(join(out, 'd'), { recursive: true });

// a library is a .kicad_symdir of one file per symbol (KiCad 9+) or a single .kicad_sym
const libs = readdirSync(src)
  .filter((f) => f.endsWith('.kicad_symdir') || f.endsWith('.kicad_sym'))
  .sort((a, b) => a.localeCompare(b));
const index: KicadIndex = { format: KICAD_FORMAT, version: TAG, libs: [], parts: [] };
let files = 0;
let bytes = 0;
for (const f of libs) {
  const lib = f.replace(/\.kicad_sym(dir)?$/, '');
  const path = join(src, f);
  const text = f.endsWith('dir')
    ? readdirSync(path)
        .filter((n) => n.endsWith('.kicad_sym'))
        .map((n) => readFileSync(join(path, n), 'utf8'))
        .join('\n')
    : readFileSync(path, 'utf8');
  const { parts, drawings } = readKicadLibrary(text);
  if (!parts.length) continue;
  const li = index.libs.length;
  index.libs.push({ name: lib, group: kicadGroup(lib) });
  mkdirSync(join(out, 'd', lib), { recursive: true });
  const fileOf = new Map<string, number>();
  for (const [root, units] of drawings) {
    const n = fileOf.size;
    fileOf.set(root, n);
    const json = JSON.stringify(units);
    writeFileSync(join(out, 'd', lib, `${n}.json`), json);
    files++;
    bytes += json.length;
  }
  for (const p of parts) {
    const units = drawings.get(p.root)?.length ?? 1;
    index.parts.push([li, p.name, fileOf.get(p.root) ?? 0, p.ref, p.value === p.name ? '' : p.value, p.description ?? '', p.keywords ?? '', units, p.power ? 1 : 0, p.datasheet ?? '', p.footprint ?? '']);
  }
}
writeFileSync(join(out, 'index.json'), JSON.stringify(index));
const license = readFileSync(join(src, 'LICENSE.md'), 'utf8');
writeFileSync(
  join(out, 'LICENSE.md'),
  `# KiCad symbols in Nodal\n\nThese symbols are converted from the KiCad symbol libraries (${TAG}, ${REPO}),\n© the KiCad library contributors, and are shared under the same licence:\n\n${license}`,
);
console.log(`${index.parts.length} parts in ${index.libs.length} libraries, ${files} drawings (${(bytes / 1e6).toFixed(1)} MB) → ${out}`);
