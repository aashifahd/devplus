// Generate THIRD_PARTY_NOTICES.md from the production dependencies in package-lock.json,
// and fail if any of them carries a license that isn't known to be GPL-3.0 compatible.
//   node scripts/notices.mjs           write the file
//   node scripts/notices.mjs --check   only check licenses
import { existsSync, readFileSync, readdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const lock = JSON.parse(readFileSync(join(root, 'package-lock.json'), 'utf8'))

// Permissive or weak-copyleft licenses that can be combined into a GPL-3.0 program.
const COMPATIBLE = new Set([
  'MIT', 'MIT-0', 'ISC', 'BSD-2-Clause', 'BSD-3-Clause', '0BSD', 'Apache-2.0', 'Zlib', 'Unlicense', 'CC0-1.0',
  'BlueOak-1.0.0', 'Python-2.0', 'CC-BY-3.0', 'CC-BY-4.0', 'MPL-2.0', 'LGPL-2.1-or-later', 'LGPL-3.0-or-later',
  'GPL-3.0-or-later', 'GPL-3.0-only', 'WTFPL', 'Artistic-2.0', 'BSD-3-Clause-Clear'
])

function licenseOf(meta) {
  const l = meta.license ?? meta.licenses
  if (!l) return 'UNKNOWN'
  if (typeof l === 'string') return l
  if (Array.isArray(l)) return l.map((x) => x.type ?? x).join(' OR ')
  return l.type ?? 'UNKNOWN'
}

/** An SPDX expression passes when every AND-part has at least one compatible OR-option. */
function compatible(expr) {
  const clean = expr.replace(/[()]/g, ' ')
  return clean.split(/\s+AND\s+/).every((part) => part.split(/\s+OR\s+/).some((x) => COMPATIBLE.has(x.trim())))
}

// Bundled into the renderer by Vite, so they ship even though they're devDependencies.
const BUNDLED = ['@glideapps/glide-data-grid', 'leaflet', 'lucide-react', 'monaco-editor', 'nanoid', 'react', 'react-dom', 'sql-formatter', 'zustand']
const bundled = new Set()
const visit = (name) => {
  const key = `node_modules/${name}`
  if (bundled.has(key) || !lock.packages[key]) return
  bundled.add(key)
  for (const dep of Object.keys(lock.packages[key].dependencies ?? {})) visit(dep)
}
BUNDLED.forEach(visit)

const pkgs = []
for (const [path, info] of Object.entries(lock.packages)) {
  if (!path || !path.includes('node_modules/')) continue
  if ((info.dev || info.devOptional) && !bundled.has(path)) continue
  const dir = join(root, path)
  if (!existsSync(join(dir, 'package.json'))) continue // optional dependency for another platform
  const meta = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  const licenseFile = readdirSync(dir).find((f) => /^(licen[cs]e|copying|notice)(\.|$)/i.test(f))
  pkgs.push({
    name: meta.name ?? path.split('node_modules/').pop(),
    version: meta.version,
    license: licenseOf(meta),
    repo: typeof meta.repository === 'string' ? meta.repository : meta.repository?.url ?? '',
    text: licenseFile ? readFileSync(join(dir, licenseFile), 'utf8').trim() : ''
  })
}
pkgs.sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))

const bad = pkgs.filter((p) => !compatible(p.license))
for (const p of bad) console.error(`license needs review: ${p.name}@${p.version}: ${p.license}`)
console.log(`${pkgs.length} production packages, ${bad.length} need review`)

if (!process.argv.includes('--check')) {
  const seen = new Set()
  const out = [
    '# Third-party notices',
    '',
    'DevPlus is licensed under GPL-3.0-or-later (see LICENSE). It includes the following open-source packages.',
    'Electron and Chromium notices ship with the app in LICENSES.chromium.html.',
    '',
    '| Package | Version | License |',
    '|---|---|---|',
    ...pkgs.map((p) => `| ${p.name} | ${p.version} | ${p.license} |`),
    '',
    '## License texts',
    ''
  ]
  for (const p of pkgs) {
    // Many packages share identical license text; print each distinct text once per package name.
    const key = `${p.name}\n${p.text}`
    if (!p.text || seen.has(key)) continue
    seen.add(key)
    out.push(`### ${p.name}`, '', '```', p.text, '```', '')
  }
  writeFileSync(join(root, 'build', 'THIRD_PARTY_NOTICES.md'), out.join('\n'))
  console.log('wrote build/THIRD_PARTY_NOTICES.md')
}
if (bad.length) process.exitCode = 1
