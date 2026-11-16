// Git smart-HTTP: pkt-lines, packfile read/write (with OFS/REF delta resolution), and the
// upload-pack / receive-pack handlers for protocol v2 and v0. Implemented from the protocol,
// on node:zlib and node:crypto only — no git binary anywhere.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import {
  ZERO_OID,
  addObject,
  collect,
  commitOf,
  hashObject,
  isAncestor,
  parseTagTarget,
  peel,
  type GitObject,
  type Repo,
} from './core.ts';

// ---------------------------------------------------------------------------
// pkt-lines
// ---------------------------------------------------------------------------

export function pkt(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export const PKT_FLUSH = Buffer.from('0000', 'ascii');
export const PKT_DELIM = Buffer.from('0001', 'ascii');
export const PKT_RESPONSE_END = Buffer.from('0002', 'ascii');

export interface ParsedPkt {
  kind: 'data' | 'flush' | 'delim' | 'response-end';
  payload: Buffer;
}

/** Parse pkt-lines from the front of `buf`; `rest` is whatever follows the first flush. */
export function parsePkts(buf: Buffer): { packets: ParsedPkt[]; rest: Buffer } {
  const packets: ParsedPkt[] = [];
  let offset = 0;
  while (offset + 4 <= buf.length) {
    const header = buf.subarray(offset, offset + 4).toString('ascii');
    if (!/^[0-9a-fA-F]{4}$/.test(header)) break;
    const length = parseInt(header, 16);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
      return { packets, rest: buf.subarray(offset) };
    }
    if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length === 2) {
      packets.push({ kind: 'response-end', payload: Buffer.alloc(0) });
      offset += 4;
      continue;
    }
    if (length < 4 || offset + length > buf.length) break;
    packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
    offset += length;
  }
  return { packets, rest: buf.subarray(offset) };
}

// ---------------------------------------------------------------------------
// packfiles
// ---------------------------------------------------------------------------

const TYPE_IDS: Record<string, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const ID_TYPES: Record<number, string> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

/** Write a plain (delta-free) version-2 pack holding `oids`, in a stable order. */
// Pack cache: fetches are content-addressed, so an identical object set always produces an
// identical pack. Concurrent clones of the same tip (the common case) reuse one computation.
const packCache = new Map<string, Buffer>();
let packCacheBytes = 0;
const PACK_CACHE_LIMIT = 32 * 1024 * 1024;

export function writePack(repo: Repo, oids: Iterable<string>): Buffer {
  const unique = [...new Set(oids)].sort();
  const cacheKey = createHash('sha1').update(unique.join(',')).digest('hex');
  const cached = packCache.get(cacheKey);
  if (cached) return cached;
  const order = { commit: 0, tree: 1, blob: 2, tag: 3 } as Record<string, number>;
  const list = unique
    .map((oid) => ({ oid, obj: repo.objects.get(oid) }))
    .filter((entry): entry is { oid: string; obj: GitObject } => entry.obj !== undefined)
    .sort((a, b) => (order[a.obj.type] - order[b.obj.type]) || (a.oid < b.oid ? -1 : 1));
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const { obj } of list) {
    const size = obj.data.length;
    let first = (TYPE_IDS[obj.type] << 4) | (size & 0x0f);
    let rest = Math.floor(size / 16);
    const bytes: number[] = [];
    if (rest > 0) first |= 0x80;
    bytes.push(first);
    while (rest > 0) {
      let byte = rest & 0x7f;
      rest = Math.floor(rest / 128);
      if (rest > 0) byte |= 0x80;
      bytes.push(byte);
    }
    parts.push(Buffer.from(bytes));
    parts.push(deflateSync(obj.data, { level: 1 }));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  const pack = Buffer.concat([body, trailer]);
  if (packCacheBytes + pack.length > PACK_CACHE_LIMIT) {
    packCache.clear();
    packCacheBytes = 0;
  }
  packCache.set(cacheKey, pack);
  packCacheBytes += pack.length;
  return pack;
}

function inflateAt(buf: Buffer, offset: number): { data: Buffer; next: number } {
  const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, next: offset + result.engine.bytesWritten };
}

/** Apply a git delta stream to a base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let offset = 0;
  const readSize = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[offset++];
      value += (byte & 0x7f) * 2 ** shift;
      shift += 7;
      if (!(byte & 0x80)) break;
    }
    return value;
  };
  const sourceSize = readSize();
  const targetSize = readSize();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const out = Buffer.alloc(targetSize);
  let written = 0;
  while (offset < delta.length) {
    const op = delta[offset++];
    if (op & 0x80) {
      let copyOffset = 0;
      let copySize = 0;
      let shift = 0;
      for (let bit = 0; bit < 4; bit += 1) {
        if (op & (1 << bit)) copyOffset += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      shift = 0;
      for (let bit = 4; bit < 7; bit += 1) {
        if (op & (1 << bit)) copySize += delta[offset++] * 2 ** shift;
        shift += 8;
      }
      if (copySize === 0) copySize = 0x10000;
      base.copy(out, written, copyOffset, copyOffset + copySize);
      written += copySize;
    } else if (op !== 0) {
      const literal = op & 0x7f;
      delta.copy(out, written, offset, offset + literal);
      offset += literal;
      written += literal;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  if (written !== targetSize) throw new Error('delta produced the wrong size');
  return out;
}

/**
 * Read a pack into a staging map (oid -> object), resolving OFS_DELTA and REF_DELTA against
 * the pack itself and the repository's store (thin packs). Throws on any structural problem.
 */
export function readPack(repo: Repo, pack: Buffer): Map<string, GitObject> {
  if (pack.length < 12 + 20 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`pack version ${version}`);
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack checksum mismatch');
  const staged = new Map<string, GitObject>();
  const byOffset = new Map<number, string>();
  let offset = 12;
  interface Pending {
    kind: 'ofs' | 'ref';
    baseOid?: string;
    baseOffset?: number;
    delta: Buffer;
    offset: number;
  }
  const pending: Pending[] = [];
  const put = (type: string, data: Buffer, at: number): string => {
    const oid = hashObject(type, data);
    staged.set(oid, { type, data });
    byOffset.set(at, oid);
    return oid;
  };
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    let byte = pack[offset++];
    const typeId = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[offset++];
      size += (byte & 0x7f) * 2 ** shift;
      shift += 7;
    }
    if (typeId === 6) {
      // OFS_DELTA
      let b = pack[offset++];
      let baseOffset = b & 0x7f;
      while (b & 0x80) {
        b = pack[offset++];
        baseOffset = (baseOffset + 1) * 128 + (b & 0x7f);
      }
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      pending.push({ kind: 'ofs', baseOffset: entryOffset - baseOffset, delta: inflated.data, offset: entryOffset });
    } else if (typeId === 7) {
      // REF_DELTA
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      pending.push({ kind: 'ref', baseOid, delta: inflated.data, offset: entryOffset });
    } else {
      const type = ID_TYPES[typeId];
      if (!type) throw new Error(`pack entry type ${typeId}`);
      const inflated = inflateAt(pack, offset);
      offset = inflated.next;
      if (inflated.data.length !== size) throw new Error('pack entry size mismatch');
      put(type, inflated.data, entryOffset);
    }
  }
  // Resolve deltas, possibly in chains.
  let guard = 0;
  while (pending.length && guard < 1000) {
    guard += 1;
    let progressed = false;
    for (let i = pending.length - 1; i >= 0; i -= 1) {
      const entry = pending[i];
      const baseOid = entry.kind === 'ofs' ? byOffset.get(entry.baseOffset!) : entry.baseOid!;
      const base = (baseOid ? staged.get(baseOid) : undefined) ?? (baseOid ? repo.objects.get(baseOid) : undefined);
      if (!base) continue;
      const data = applyDelta(base.data, entry.delta);
      put(base.type, data, entry.offset);
      pending.splice(i, 1);
      progressed = true;
    }
    if (!progressed) throw new Error('pack delta base is missing');
  }
  if (pending.length) throw new Error('pack deltas did not resolve');
  return staged;
}

// ---------------------------------------------------------------------------
// ref advertisement
// ---------------------------------------------------------------------------

export const AGENT = 'makefun-forge/1.0';
const UPLOAD_CAPS = `multi_ack_detailed no-done side-band-64k thin-pack ofs-delta deepen-since deepen-not agent=${AGENT}`;
const RECEIVE_CAPS = `report-status delete-refs side-band-64k ofs-delta agent=${AGENT}`;

function sortedRefs(repo: Repo): Array<[string, string]> {
  return [...repo.refs.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function headRef(repo: Repo): string {
  return `refs/heads/${repo.defaultBranch}`;
}

/** The v0 advertisement body for either service. */
export function v0Advertisement(repo: Repo, service: string): Buffer {
  const caps = service === 'git-receive-pack' ? RECEIVE_CAPS : `${UPLOAD_CAPS} symref=HEAD:${headRef(repo)}`;
  const parts: Buffer[] = [pkt(`# service=${service}\n`), PKT_FLUSH];
  const refs = sortedRefs(repo);
  const headOid = repo.refs.get(headRef(repo)) ?? ZERO_OID;
  if (refs.length === 0) {
    parts.push(pkt(`${ZERO_OID} capabilities^{}\0${caps}\n`));
  } else {
    parts.push(pkt(`${headOid} HEAD\0${caps}\n`));
    for (const [name, oid] of refs) {
      parts.push(pkt(`${oid} ${name}\n`));
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') parts.push(pkt(`${peel(repo, oid)} ${name}^{}\n`));
    }
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** The v2 capability advertisement for upload-pack. */
export function v2Advertisement(): Buffer {
  return Buffer.concat([
    pkt('version 2\n'),
    pkt(`agent=${AGENT}\n`),
    pkt('ls-refs=unborn\n'),
    pkt('fetch=shallow\n'),
    pkt('object-format=sha1\n'),
    PKT_FLUSH,
  ]);
}

// ---------------------------------------------------------------------------
// ls-refs (v2)
// ---------------------------------------------------------------------------

export function lsRefs(repo: Repo, args: string[]): Buffer {
  const peelWanted = args.includes('peel');
  const symrefsWanted = args.includes('symrefs');
  const unbornWanted = args.includes('unborn');
  const prefixes = args.filter((a) => a.startsWith('ref-prefix ')).map((a) => a.slice('ref-prefix '.length));
  const matches = (name: string): boolean => prefixes.length === 0 || prefixes.some((p) => name.startsWith(p));
  const parts: Buffer[] = [];
  const head = headRef(repo);
  const headOid = repo.refs.get(head);
  if (matches('HEAD')) {
    if (headOid !== undefined) {
      parts.push(pkt(`${headOid} HEAD${symrefsWanted ? ` symref-target:${head}` : ''}\n`));
    } else if (unbornWanted) {
      parts.push(pkt(`unborn HEAD${symrefsWanted ? ` symref-target:${head}` : ''}\n`));
    }
  }
  for (const [name, oid] of sortedRefs(repo)) {
    if (!matches(name)) continue;
    let line = `${oid} ${name}`;
    if (peelWanted) {
      const obj = repo.objects.get(oid);
      if (obj && obj.type === 'tag') line += ` peeled:${peel(repo, oid)}`;
    }
    parts.push(pkt(`${line}\n`));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// fetch (upload-pack)
// ---------------------------------------------------------------------------

export interface FetchArgs {
  wants: string[];
  haves: string[];
  shallow: string[];
  deepen: number | null;
  done: boolean;
}

export function parseFetchArgs(lines: string[]): FetchArgs {
  const args: FetchArgs = { wants: [], haves: [], shallow: [], deepen: null, done: false };
  for (const line of lines) {
    if (line.startsWith('want ')) args.wants.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('have ')) args.haves.push(line.slice(5).trim().split(' ')[0]);
    else if (line.startsWith('shallow ')) args.shallow.push(line.slice(8).trim().split(' ')[0]);
    else if (line.startsWith('deepen ')) args.deepen = Number.parseInt(line.slice(7).trim(), 10);
    else if (line === 'done') args.done = true;
  }
  return args;
}

interface FetchPlan {
  send: string[];
  boundary: string[];
  unshallow: string[];
  ackLines: string[];
  nothingToSend: boolean;
}

/** Work out which objects a fetch sends, honouring haves, depth and the client's shallow list. */
export function planFetch(repo: Repo, args: FetchArgs): FetchPlan {
  const clientShallow = new Set(args.shallow);
  const haveSet = args.haves.length
    ? collect(repo, args.haves.filter((oid) => repo.objects.has(oid)), { leaves: clientShallow }).objects
    : new Set<string>();
  let included: ReturnType<typeof collect>;
  if (args.deepen !== null && Number.isFinite(args.deepen)) {
    included = collect(repo, args.wants.filter((oid) => repo.objects.has(oid)), { maxGen: args.deepen });
  } else if (clientShallow.size > 0) {
    included = collect(repo, args.wants.filter((oid) => repo.objects.has(oid)), { leaves: clientShallow });
  } else {
    included = collect(repo, args.wants.filter((oid) => repo.objects.has(oid)));
  }
  const send = [...included.objects].filter((oid) => !haveSet.has(oid));
  const boundary = [...included.boundary];
  const unshallow = [...clientShallow].filter((oid) => included.commits.has(oid) && !included.boundary.has(oid));
  const ackLines: string[] = [];
  const presentHaves = args.haves.filter((oid) => repo.objects.has(oid));
  if (presentHaves.length) for (const oid of presentHaves) ackLines.push(`ACK ${oid}`);
  else if (args.haves.length) ackLines.push('NAK');
  return { send, boundary, unshallow, ackLines, nothingToSend: send.length === 0 };
}

function sidebandPack(repo: Repo, oids: string[]): Buffer[] {
  const pack = writePack(repo, oids);
  const parts: Buffer[] = [];
  const CHUNK = 32768;
  for (let offset = 0; offset < pack.length; offset += CHUNK) {
    const chunk = pack.subarray(offset, offset + CHUNK);
    parts.push(pkt(Buffer.concat([Buffer.from([1]), chunk])));
  }
  return parts;
}

/** A v2 fetch response: acknowledgments, shallow-info, then the packfile section. */
export function fetchV2(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  if (!args.done) {
    // Negotiation round: acknowledgments only, no packfile yet.
    const acks = plan.ackLines.length ? [...plan.ackLines] : ['NAK'];
    if (plan.nothingToSend && plan.ackLines.length) acks.push('ready');
    parts.push(pkt('acknowledgments\n'));
    for (const line of acks) parts.push(pkt(`${line}\n`));
    parts.push(PKT_FLUSH);
    return Buffer.concat(parts);
  }
  // With `done` sent, negotiation is over: no acknowledgments section (real git rejects
  // one here), just shallow-info when the boundary moved and the packfile section.
  if (plan.boundary.length || plan.unshallow.length) {
    parts.push(pkt('shallow-info\n'));
    for (const oid of plan.boundary) parts.push(pkt(`shallow ${oid}\n`));
    for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
    parts.push(PKT_FLUSH);
  }
  parts.push(pkt('packfile\n'));
  parts.push(...sidebandPack(repo, plan.send));
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

/** A v0 fetch response: shallow lines, NAK, then the sideband pack. */
export function fetchV0(repo: Repo, args: FetchArgs): Buffer {
  const plan = planFetch(repo, args);
  const parts: Buffer[] = [];
  for (const oid of plan.boundary) parts.push(pkt(`shallow ${oid}\n`));
  for (const oid of plan.unshallow) parts.push(pkt(`unshallow ${oid}\n`));
  parts.push(pkt('NAK\n'));
  if (!plan.nothingToSend) {
    parts.push(...sidebandPack(repo, plan.send));
  }
  parts.push(PKT_FLUSH);
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------------------
// receive-pack
// ---------------------------------------------------------------------------

export interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

export interface PushOutcome {
  status: number;
  body: Buffer;
}

/** Handle one git-receive-pack POST: command list + optional pack, report-status out. */
export function receivePack(repo: Repo, body: Buffer): PushOutcome {
  const { packets, rest } = parsePkts(body);
  const commands: PushCommand[] = [];
  let capabilities = '';
  for (const packet of packets) {
    if (packet.kind === 'flush') break;
    if (packet.kind !== 'data') continue;
    let line = packet.payload.toString('utf8').replace(/\n$/, '');
    const nul = line.indexOf('\0');
    if (nul >= 0) {
      capabilities = line.slice(nul + 1);
      line = line.slice(0, nul);
    }
    const fields = line.split(' ');
    if (fields.length >= 3) {
      commands.push({ oldOid: fields[0], newOid: fields[1], ref: fields.slice(2).join(' ') });
    }
  }
  const caps = new Set(capabilities.split(' ').filter(Boolean));
  const wantsReport = caps.has('report-status') || caps.has('report-status-v2');
  const useSideband = caps.has('side-band-64k');

  let unpackError: string | null = null;
  let staged = new Map<string, GitObject>();
  const packBytes = rest;
  if (packBytes.length > 0) {
    try {
      staged = readPack(repo, packBytes);
    } catch (err) {
      unpackError = err instanceof Error ? err.message : String(err);
    }
  } else if (commands.some((command) => command.newOid !== ZERO_OID)) {
    // A bare command list with updates and no pack at all: real git calls this an unpack error
    // only when the objects are missing; create-from-existing sends an empty pack, handled above.
    const missing = commands.some(
      (command) => command.newOid !== ZERO_OID && !repo.objects.has(command.newOid),
    );
    if (missing) unpackError = 'missing objects and no pack was sent';
  }

  // Objects visible while validating: the repo's own plus the staged pack.
  const visible = (oid: string): GitObject | undefined => staged.get(oid) ?? repo.objects.get(oid);
  const visibleRepo: Repo = {
    ...repo,
    objects: new Map([...repo.objects, ...staged]),
    commitCache: repo.commitCache,
  };

  const results: Array<{ ref: string; ok: boolean; reason: string }> = [];
  if (unpackError !== null) {
    for (const command of commands) results.push({ ref: command.ref, ok: false, reason: 'unpacker error' });
  } else {
    for (const command of commands) {
      const current = repo.refs.get(command.ref) ?? ZERO_OID;
      let ok = true;
      let reason = '';
      if (command.oldOid !== current) {
        ok = false;
        reason = 'reference already exists';
      } else if (command.newOid === ZERO_OID) {
        if (command.ref === headRef(repo)) {
          ok = false;
          reason = 'deletion of the current branch prohibited';
        } else if (current === ZERO_OID) {
          ok = false;
          reason = 'reference does not exist';
        }
      } else {
        const target = visible(command.newOid);
        if (!target) {
          ok = false;
          reason = 'invalid object';
        } else if (command.ref.startsWith('refs/heads/') && target.type !== 'commit') {
          ok = false;
          reason = 'invalid object';
        } else if (current !== ZERO_OID) {
          const newCommit = target.type === 'tag' ? peel(visibleRepo, command.newOid) : command.newOid;
          const oldCommit = (() => {
            const currentObj = visible(current);
            return currentObj && currentObj.type === 'tag' ? peel(visibleRepo, current) : current;
          })();
          if (!isAncestor(visibleRepo, oldCommit, newCommit)) {
            ok = false;
            reason = 'non-fast-forward';
          }
        }
      }
      results.push({ ref: command.ref, ok, reason });
      if (ok) {
        if (command.newOid === ZERO_OID) repo.refs.delete(command.ref);
        else repo.refs.set(command.ref, command.newOid);
      }
    }
    // The pack unpacked fine: its objects join the store even when a ref was refused (they
    // stay unreachable, so no fetch can serve them until a ref names them).
    for (const [oid, obj] of staged) if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
  }

  if (!wantsReport) return { status: 200, body: Buffer.alloc(0) };
  const reportLines: Buffer[] = [];
  reportLines.push(pkt(unpackError !== null ? `unpack ${unpackError}\n` : 'unpack ok\n'));
  for (const result of results) {
    reportLines.push(pkt(result.ok ? `ok ${result.ref}\n` : `ng ${result.ref} ${result.reason}\n`));
  }
  const reportStream = Buffer.concat([...reportLines, PKT_FLUSH]);
  if (useSideband) {
    // The whole report stream, terminating flush included, travels inside band 1; a bare
    // flush packet then ends the sideband stream itself.
    const parts: Buffer[] = [];
    const CHUNK = 32768;
    for (let offset = 0; offset < reportStream.length; offset += CHUNK) {
      parts.push(pkt(Buffer.concat([Buffer.from([1]), reportStream.subarray(offset, offset + CHUNK)])));
    }
    parts.push(PKT_FLUSH);
    return { status: 200, body: Buffer.concat(parts) };
  }
  return { status: 200, body: reportStream };
}

// ---------------------------------------------------------------------------
// upload-pack POST dispatch (v2 commands and the v0 fallback)
// ---------------------------------------------------------------------------

export function uploadPack(repo: Repo, body: Buffer, protocolV2: boolean): { status: number; body: Buffer } {
  const { packets } = parsePkts(body);
  const lines = packets.filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''));
  if (!protocolV2) {
    // v0: want/have/done lines.
    const args = parseFetchArgs(lines.filter((l) => l !== 'done'));
    // v0 wants ride on the first want line with capabilities appended after a NUL/space; the
    // parser above already split on spaces for 'want <oid>' prefixes only when exact — rebuild:
    if (!args.wants.length) {
      for (const line of lines) {
        const match = /^want ([0-9a-f]{40})/.exec(line);
        if (match) args.wants.push(match[1]);
      }
    }
    return { status: 200, body: fetchV0(repo, args) };
  }
  const commandLine = lines[0] ?? '';
  const delimIndex = packets.findIndex((p) => p.kind === 'delim');
  const argLines = delimIndex >= 0
    ? packets.slice(delimIndex + 1).filter((p) => p.kind === 'data').map((p) => p.payload.toString('utf8').replace(/\n$/, ''))
    : lines.slice(1);
  if (commandLine === 'command=ls-refs') {
    return { status: 200, body: lsRefs(repo, argLines) };
  }
  if (commandLine === 'command=fetch') {
    return { status: 200, body: fetchV2(repo, parseFetchArgs(argLines)) };
  }
  return { status: 400, body: Buffer.from('error: unknown command\n', 'utf8') };
}

export { parseTagTarget };
export { commitOf };
