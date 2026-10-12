// _verify_green_pack.mjs -- pre-flight check for a Windows "green" (portable) build.
//
// WHY THIS EXISTS
// ---------------
// electron-builder's `asarUnpack` rule moves node_modules/libsql/**, @anthropic-ai/**
// and every *.node/*.dll OUT of app.asar into resources/app.asar.unpacked/. Electron
// keeps the entry in the asar index but rewrites the resolved path to the unpacked
// location at require() time.
//
// That means a half-deleted output directory produces a package whose asar still
// *looks* complete while the real files are gone. The failure surfaces only at
// runtime, as a module-load crash in the main process before anything is logged:
//
//     Error: ENOENT: no such file or directory, open
//       '...\resources\app.asar.unpacked\node_modules\libsql\index.js'
//
// ...followed by an invisible error dialog, i.e. the app "hangs" on launch.
//
// So: never trust the asar index alone. Every entry marked `unpacked` must exist on
// disk. That is the core check below, alongside the dist/renderer target check
// (a Capacitor/mobile renderer build accidentally packaged into the desktop shell
// renders a mobile viewport and breaks layout).
//
// Usage: node _verify_green_pack.mjs [unpackedDir]     (default release/build/win-unpacked)

import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'

const unpackedDir = path.resolve(process.argv[2] || 'release/build/win-unpacked')
const asarPath = path.join(unpackedDir, 'resources', 'app.asar')
const unpackedRoot = path.join(unpackedDir, 'resources', 'app.asar.unpacked')

const failures = []
const warnings = []
const notes = []

function fail(message) {
  failures.push(message)
}

function warn(message) {
  warnings.push(message)
}

/** Read only the asar header (a 100MB+ archive must not be slurped into memory). */
function readAsarHeader(archive) {
  const fd = fs.openSync(archive, 'r')
  try {
    const sizeBuf = Buffer.alloc(8)
    fs.readSync(fd, sizeBuf, 0, 8, 0)
    const pickleSize = sizeBuf.readUInt32LE(4)
    const buf = Buffer.alloc(pickleSize)
    fs.readSync(fd, buf, 0, pickleSize, 8)

    // The pickle body is "uint32 jsonLength" + JSON + padding. Locate the JSON
    // braces rather than trusting fixed offsets.
    const text = buf.toString('utf8')
    const start = text.indexOf('{')
    const end = text.lastIndexOf('}')
    if (start < 0 || end < start) {
      throw new Error('asar header JSON not found')
    }
    return { header: JSON.parse(text.slice(start, end + 1)), dataStart: 8 + pickleSize }
  } finally {
    fs.closeSync(fd)
  }
}

/** Read a single file out of the archive using the offset written in the header. */
function readAsarEntry(archive, entry, dataStart) {
  const size = entry.size
  if (typeof size !== 'number' || typeof entry.offset !== 'string') {
    return null
  }
  const fd = fs.openSync(archive, 'r')
  try {
    const buf = Buffer.alloc(size)
    fs.readSync(fd, buf, 0, size, dataStart + Number.parseInt(entry.offset, 10))
    return buf
  } finally {
    fs.closeSync(fd)
  }
}

function walk(node, prefix, visit) {
  for (const [name, child] of Object.entries(node.files || {})) {
    const relative = prefix ? `${prefix}/${name}` : name
    if (child.files) {
      walk(child, relative, visit)
    } else {
      visit(relative, child)
    }
  }
}

if (!fs.existsSync(unpackedDir)) {
  fail(`output directory does not exist: ${unpackedDir}`)
}
if (!fs.existsSync(asarPath)) {
  fail(`app.asar is missing: ${asarPath}`)
}

if (failures.length === 0) {
  const { header, dataStart } = readAsarHeader(asarPath)
  const asarBytes = fs.statSync(asarPath).size
  notes.push(`app.asar            : ${(asarBytes / 1024 / 1024).toFixed(1)} MB`)

  // ---- 1. required runtime entries exist in the asar index -------------------
  const requiredInAsar = [
    'package.json',
    'dist/main/main.js',
    'dist/preload/index.js',
    'dist/renderer/index.html',
  ]
  const entries = new Map()
  walk(header, '', (relative, child) => entries.set(relative, child))
  for (const entry of requiredInAsar) {
    if (!entries.has(entry)) {
      fail(`app.asar is missing required entry: ${entry}`)
    }
  }
  notes.push(`asar file entries   : ${entries.size}`)

  // ---- 2. every `unpacked` entry must really be on disk ----------------------
  // This is the check that would have caught the deleted-libsql failure.
  const unpackedEntries = []
  walk(header, '', (relative, child) => {
    if (child.unpacked) {
      unpackedEntries.push(relative)
    }
  })

  const missingUnpacked = unpackedEntries.filter(
    (relative) => !fs.existsSync(path.join(unpackedRoot, relative)),
  )

  if (unpackedEntries.length === 0) {
    fail('app.asar declares no unpacked entries — asarUnpack did not run as expected')
  } else if (missingUnpacked.length > 0) {
    fail(
      `app.asar.unpacked is incomplete: ${missingUnpacked.length}/${unpackedEntries.length} unpacked file(s) missing. ` +
        `The app will crash on require(). First missing: ${missingUnpacked.slice(0, 5).join(', ')}`,
    )
  } else {
    notes.push(`unpacked entries    : ${unpackedEntries.length} (all present on disk)`)
  }

  // ---- 3. the critical native/unpacked modules specifically -----------------
  const criticalUnpacked = [
    'node_modules/libsql/index.js',
    'node_modules/libsql/promise.js',
    'node_modules/libsql/package.json',
    'node_modules/@anthropic-ai/sandbox-runtime/package.json',
  ]
  for (const relative of criticalUnpacked) {
    const inAsar = entries.has(relative)
    const onDisk = fs.existsSync(path.join(unpackedRoot, relative))
    if (inAsar && !onDisk) {
      fail(`critical unpacked module missing on disk: ${relative}`)
    }
  }

  // ---- 4. renderer must be a desktop build, not a Capacitor/mobile one ------
  // The HTML lives inside the archive, so it has to be read through the header
  // offset table — plain fs cannot see it.
  const rendererEntry = entries.get('dist/renderer/index.html')
  if (!rendererEntry || rendererEntry.unpacked) {
    if (!rendererEntry) {
      fail('dist/renderer/index.html is not readable from app.asar')
    }
  } else {
    const html = readAsarEntry(asarPath, rendererEntry, dataStart)?.toString('utf8') ?? ''
    if (html.includes('height=device-height')) {
      fail(
        'dist/renderer/index.html carries the mobile/web viewport meta. ' +
          'The renderer was built with CHATBOX_BUILD_TARGET=mobile_app (e.g. `pnpm run mobile:sync:*`). ' +
          'Run `pnpm run build:renderer` without that env var before packaging.',
      )
    } else {
      notes.push('renderer viewport   : desktop')
    }
  }

  // ---- 5. payload hygiene: build-only files should not ship ----------------
  const junk = [...entries.keys()].filter(
    (relative) => relative.endsWith('.map') || relative.endsWith('stats.html'),
  )
  if (junk.length > 0) {
    warn(
      `${junk.length} build-only file(s) shipped in app.asar (sourcemaps / stats.html); see electron-builder.yml "files"`,
    )
  }
}

// ---- 6. Electron runtime payload ------------------------------------------
const localesDir = path.join(unpackedDir, 'locales')
if (!fs.existsSync(localesDir)) {
  fail('locales/ directory is missing — Electron cannot start')
} else {
  const paks = fs.readdirSync(localesDir).filter((name) => name.endsWith('.pak'))
  notes.push(`locale .pak files   : ${paks.length}`)
  if (paks.length === 0) {
    fail('locales/ contains no .pak files — Electron cannot start')
  } else if (paks.length < 20) {
    warn(`only ${paks.length} locale .pak file(s) present (a stock Electron ships ~55)`)
  }
}

const exePath = path.join(unpackedDir, 'Chatbox.exe')
if (!fs.existsSync(exePath)) {
  fail('Chatbox.exe is missing from the output directory')
} else {
  const exeBytes = fs.statSync(exePath).size
  if (exeBytes < 100 * 1024 * 1024) {
    fail(`Chatbox.exe looks truncated (${(exeBytes / 1024 / 1024).toFixed(1)} MB) — expected a full Electron binary`)
  }
}

for (const note of notes) {
  console.log(`  ${note}`)
}
for (const message of warnings) {
  console.warn(`  WARN  ${message}`)
}
for (const message of failures) {
  console.error(`  FAIL  ${message}`)
}

if (failures.length > 0) {
  console.error(`\n[verify] GREEN PACKAGE IS BROKEN — ${failures.length} problem(s) above.`)
  process.exit(1)
}

console.log(`\n[verify] OK — green package looks runnable: ${unpackedDir}`)
