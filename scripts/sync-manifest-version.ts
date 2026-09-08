#!/usr/bin/env bun
/**
 * Sync extension/manifest.json to the root package.json version.
 *
 * `bumpx --recursive` only rewrites package.json files, so the Chrome
 * extension manifest has to be brought along separately. Run from the
 * bump script's --execute hook, before the release commit is created.
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
const pkgPath = join(root, 'package.json')
const manifestPath = join(root, 'extension', 'manifest.json')

const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { version?: string }
if (!pkg.version)
  throw new Error(`No version field in ${pkgPath}`)

// Chrome manifests accept 1-4 dot-separated integers only, so drop any
// semver prerelease/build suffix (1.2.0-beta.1 -> 1.2.0).
const version = pkg.version.replace(/[-+].*$/, '')
if (!/^\d+(\.\d+){0,3}$/.test(version))
  throw new Error(`Version "${pkg.version}" cannot be expressed as a Chrome manifest version`)

const manifest = readFileSync(manifestPath, 'utf8')
const versionLine = /^(\s*"version"\s*:\s*")([^"]*)(")/m
const match = manifest.match(versionLine)
if (!match)
  throw new Error(`No "version" field found in ${manifestPath}`)

if (match[2] === version) {
  console.log(`extension/manifest.json already at ${version}`)
}
else {
  // Rewrite just the version line so the manifest's formatting is preserved.
  writeFileSync(manifestPath, manifest.replace(versionLine, `$1${version}$3`))
  console.log(`extension/manifest.json ${match[2]} -> ${version}`)
}
