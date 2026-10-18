// Tag the current commit as a release: v<package.json version>, pushed to origin.
// Refuses unless you're on a clean main or release/* branch that matches origin.
//   npm run release:tag
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const git = (...args) => execFileSync('git', args, { encoding: 'utf8' }).trim()
const fail = (msg) => {
  console.error(`release:tag: ${msg}`)
  process.exit(1)
}

const { version } = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const tag = `v${version}`
const branch = git('rev-parse', '--abbrev-ref', 'HEAD')

if (branch !== 'main' && !/^release\/\d+\.\d+$/.test(branch)) fail(`run this on main or a release/x.y branch, not "${branch}".`)
if (branch.startsWith('release/') && !version.startsWith(`${branch.slice('release/'.length)}.`)) {
  fail(`package.json says ${version}, which doesn't belong on ${branch}.`)
}
if (git('status', '--porcelain')) fail('the working tree has uncommitted changes.')

git('fetch', '--quiet', '--tags', 'origin', branch)
if (git('rev-parse', 'HEAD') !== git('rev-parse', `origin/${branch}`)) fail(`your ${branch} differs from origin/${branch}; pull or push first.`)
if (git('tag', '--list', tag)) fail(`${tag} already exists.`)

git('tag', '-a', tag, '-m', `DevPlus ${version}`)
git('push', 'origin', tag)
console.log(`Pushed ${tag} from ${branch}. The Release workflow is building the installers into a draft release.`)
