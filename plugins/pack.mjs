/*
 * Packs a plugin into the zip the marketplace takes.
 *
 * An upload is a .js file, or a .zip of one with the files that travel beside
 * it. A single-file plugin needs no zip at all — the raw url is the upload —
 * so what this is really for is the rest: the manifest that fills the publish
 * form in, the README it names, the icon, and the libraries a plugin declares.
 *
 *     docker compose run --rm dev npm run pack --workspace @orknux/plugins
 *     docker compose run --rm dev npm run pack --workspace @orknux/plugins -- github
 *
 * Named plugins are packed; no name packs all of them. Zips land in
 * `plugins/dist/`, which is ignored.
 *
 * ## What goes in, and what does not
 *
 * The manifest decides, which is the point of there being one: `path` names
 * the plugin, `descriptionPath` the prose, `icon` the face, and `libraries()`
 * — asked of the plugin itself, the way the server asks — names the files it
 * ships with. Everything is placed at the zip's top level, exactly where the
 * schema says an uploader will look for it.
 *
 * Nothing else in the folder is in that list, and the packer never walks one.
 * A plugin that bundled a library kept its source beside the artifact, and
 * shipping that source would have shipped a file full of bare imports that
 * cannot load at all — so the rule is that the packer only ever takes files
 * something named. None of the plugins here is a build today; the rule is what
 * makes that stay true without anybody checking.
 *
 * ## Refusing rather than shipping something broken
 *
 * Each plugin is inspected first — the same read the server does, through
 * `@orknux/plugin` — so packing fails on a plugin the server would refuse,
 * on a manifest whose `key` is not what `id()` answers, and on a declared
 * library or a named file that is not there. A zip is easy to make and hard
 * to check once it is somewhere else.
 *
 * ## Why the zip is written out longhand
 *
 * A zip of half a dozen small files is a few headers, a CRC and whatever
 * `zlib` already does — about as much code as choosing a library, arguing
 * about its licence and pinning its version. Written here it also comes out
 * *deterministic*: every entry carries the same fixed timestamp, so packing
 * the same plugin twice gives the same bytes, and a zip that differs is a
 * plugin that changed.
 *
 * Licensed under the Apache License, Version 2.0.
 * SPDX-License-Identifier: Apache-2.0
 */

import { deflateRawSync } from 'node:zlib';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { inspect } from '../plugin/dist/tooling.js';

const here = fileURLToPath(new URL('.', import.meta.url));
const out = `${here}dist/`;

/**
 * The timestamp every entry carries: 1980-01-01, which is the earliest a zip
 * can spell. Fixed rather than now, so the same input packs to the same bytes.
 */
const DOS_DATE = 0x0021;
const DOS_TIME = 0x0000;

/**
 * A regular file, 0644, as the high half of the external attributes.
 *
 * Coerced back to unsigned: the shift overflows into a negative signed
 * 32-bit integer, which is not a thing a zip field can hold.
 */
const UNIX_0644 = (0o100644 << 16) >>> 0;

/** CRC-32, as the zip format wants it: reflected, polynomial 0xEDB88320. */
const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let index = 0; index < 256; index++) {
    let value = index;
    for (let bit = 0; bit < 8; bit++) {
      value = value & 1 ? (value >>> 1) ^ 0xedb88320 : value >>> 1;
    }
    table[index] = value >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let value = 0xffffffff;
  for (let at = 0; at < bytes.length; at++) {
    value = (value >>> 8) ^ CRC_TABLE[(value ^ bytes[at]) & 0xff];
  }
  return (value ^ 0xffffffff) >>> 0;
}

/**
 * The entries as one zip.
 *
 * Deflated where that is smaller and stored where it is not, which is what
 * every writer does and matters here because an icon is a few hundred bytes
 * that deflate makes bigger.
 */
function zipped(entries) {
  const locals = [];
  const central = [];
  let offset = 0;

  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8');
    const deflated = deflateRawSync(entry.bytes, { level: 9 });
    const stored = deflated.length >= entry.bytes.length;
    const body = stored ? entry.bytes : deflated;
    const method = stored ? 0 : 8;
    const crc = crc32(entry.bytes);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // the version that can open it
    local.writeUInt16LE(0, 6); // no flags: no encryption, sizes known up front
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(DOS_TIME, 10);
    local.writeUInt16LE(DOS_DATE, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(entry.bytes.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28); // no extra field
    locals.push(local, name, body);

    const header = Buffer.alloc(46);
    header.writeUInt32LE(0x02014b50, 0);
    header.writeUInt16LE(20, 4); // version made by
    header.writeUInt16LE(20, 6); // version needed
    header.writeUInt16LE(0, 8);
    header.writeUInt16LE(method, 10);
    header.writeUInt16LE(DOS_TIME, 12);
    header.writeUInt16LE(DOS_DATE, 14);
    header.writeUInt32LE(crc, 16);
    header.writeUInt32LE(body.length, 20);
    header.writeUInt32LE(entry.bytes.length, 24);
    header.writeUInt16LE(name.length, 28);
    header.writeUInt16LE(0, 30); // extra
    header.writeUInt16LE(0, 32); // comment
    header.writeUInt16LE(0, 34); // disk it starts on
    header.writeUInt16LE(0, 36); // internal attributes
    header.writeUInt32LE(UNIX_0644, 38);
    header.writeUInt32LE(offset, 42);
    central.push(header, name);

    offset += local.length + name.length + body.length;
  }

  const directory = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4); // this disk
  end.writeUInt16LE(0, 6); // the disk the directory starts on
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(directory.length, 12);
  end.writeUInt32LE(offset, 16);
  end.writeUInt16LE(0, 20); // no comment

  return Buffer.concat([...locals, directory, end]);
}

/** Every directory under `plugins/` is a plugin; the loose files beside them are not. */
function shipped() {
  return readdirSync(here).filter((name) => {
    try {
      return statSync(here + name).isDirectory() && name !== 'dist';
    } catch {
      return false;
    }
  });
}

/** One plugin read, checked, and turned into the entries its zip holds. */
async function packed(key) {
  const folder = `${here}${key}/`;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(`${folder}plugin.json`, 'utf8'));
  } catch (failure) {
    throw new Error(`${key} has no readable plugin.json: ${failure.message}`);
  }

  const file = manifest.path ?? `${key}.js`;
  /*
   * Inspected before anything is packed: this is the read the server does, so
   * a plugin it would refuse is refused here instead of at the upload — and
   * `libraries()` comes back from the plugin itself rather than from a list
   * somebody has to remember to keep.
   */
  const inspected = await inspect(folder + file);
  if (manifest.key !== inspected.id) {
    throw new Error(
      `${key}: the manifest says ${manifest.key} and the code answers ${inspected.id}`,
    );
  }
  if (!inspected.withinSizeLimit) {
    throw new Error(`${key}: ${file} is larger than a plugin may be`);
  }

  /* What the manifest names, plus the manifest itself — in the order a reader would. */
  const wanted = ['plugin.json', file, manifest.descriptionPath ?? 'README.md'];
  const icon = manifest.icon;
  if (typeof icon === 'string' && icon.endsWith('.svg') && !/^(https?|data):/.test(icon)) {
    wanted.push(icon);
    /*
     * And its white twin, where there is one. The manifest names only the
     * light glyph — the other is found by the `-white` suffix, which is the
     * convention the marketplace resolves a dark listing with, so a zip that
     * carried only the named one would arrive half-dressed.
     */
    const white = icon.replace(/\.svg$/, '-white.svg');
    if (existsSync(folder + white)) {
      wanted.push(white);
    }
  }
  /* And the files the plugin says travel with it, spelled as it declares them. */
  for (const library of inspected.libraries) {
    wanted.push(library.replace(/^\.\//, ''));
  }

  const entries = [];
  for (const name of wanted) {
    let bytes;
    try {
      bytes = readFileSync(folder + name);
    } catch {
      throw new Error(`${key}: ${name} is named but not there`);
    }
    entries.push({ name: name, bytes: bytes });
  }
  return { manifest, inspected, entries };
}

const asked = process.argv.slice(2).filter((one) => !one.startsWith('-'));
const keys = asked.length > 0 ? asked : shipped();
const missing = keys.filter((key) => !shipped().includes(key));
if (missing.length > 0) {
  console.error(`no plugin called ${missing.join(', ')}; there is ${shipped().join(', ')}`);
  process.exit(1);
}

mkdirSync(out, { recursive: true });
for (const key of keys) {
  const { manifest, inspected, entries } = await packed(key);
  const zip = zipped(entries);
  const name = `${manifest.key}-${manifest.version}.zip`;

  /*
   * The older zips for this plugin go first.
   *
   * A version bump used to leave the previous zip sitting beside the new one,
   * and a folder holding `pdf-0.1.0.zip` and `pdf-0.4.0.zip` offers the stale
   * one first in every file picker that sorts by name. That is not a tidiness
   * problem: the old file installs, fails for a reason fixed weeks ago, and
   * the reading of it is "the fix did not work" - which is exactly how an
   * afternoon goes missing.
   *
   * Only this plugin's own, matched on the key and a version: a zip somebody
   * put here by hand is not this script's to delete.
   */
  for (const stale of readdirSync(out)) {
    if (stale === name) continue;
    if (!/^(.+)-\d+\.\d+\.\d+\.zip$/.test(stale)) continue;
    if (stale.slice(0, stale.lastIndexOf('-')) !== manifest.key) continue;
    rmSync(out + stale);
    console.log(`dist/${stale}  removed (older than ${manifest.version})`);
  }

  writeFileSync(out + name, zip);

  const size = (bytes) => (bytes < 1024 ? `${bytes} B` : `${(bytes / 1024).toFixed(1)} KB`);
  console.log(`dist/${name}  ${size(zip.length)}`);
  for (const entry of entries) {
    console.log(`  ${entry.name.padEnd(28)} ${size(entry.bytes.length)}`);
  }
  if (inspected.libraries.length === 0 && entries.length === 3) {
    console.log(`  (a single-file plugin: ${manifest.path ?? `${key}.js`} can also be loaded by url as it stands)`);
  }
}
