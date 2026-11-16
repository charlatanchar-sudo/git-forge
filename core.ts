// Core state and git object engine for the makefun forge: an in-memory object store with real
// SHA-1 git objects (commit/tree/blob/tag), reachability, ancestry, three-way tree merges and
// line diffs. No git binary, no dependencies: node:crypto and node:zlib only.

import { createHash } from 'node:crypto';

export interface GitObject {
  type: string; // 'commit' | 'tree' | 'blob' | 'tag'
  data: Buffer;
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export interface CommitView {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface LabelRec {
  id: number;
  name: string;
  color: string;
  description: string | null;
}

export interface CommentRec {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface IssueRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string; // 'open' | 'closed'
  labels: string[];
  comments: CommentRec[];
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  seq: number;
}

export interface PullRec {
  id: number;
  number: number;
  title: string;
  body: string;
  state: string; // 'open' | 'closed'
  head: string;
  base: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  closedAt: string | null;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  description: string | null;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  commitCache: Map<string, CommitView>;
  treeCache: Map<string, Map<string, { oid: string; mode: string }>>;
  labels: Map<string, LabelRec>;
  issues: Map<number, IssueRec>;
  pulls: Map<number, PullRec>;
  nextNumber: number;
  nextLabelId: number;
}

export const ZERO_OID = '0'.repeat(40);

export const state = {
  repos: new Map<string, Repo>(),
  viewerLogin: null as string | null,
  nextRepoId: 5001,
  nextIssueId: 100001,
  nextCommentId: 200001,
  seq: 0,
};

export function nowIso(): string {
  return new Date().toISOString();
}

export function nextSeq(): number {
  state.seq += 1;
  return state.seq;
}

/** The login every repo belongs to; bound by the first repo-addressed request (see lookupRepo). */
export function viewerLogin(): string {
  return state.viewerLogin ?? 'viewer';
}

// ---------------------------------------------------------------------------
// repository registry
// ---------------------------------------------------------------------------

export function createRepo(name: string, description: string | null, isPrivate: boolean): Repo | null {
  if (state.repos.has(name)) return null;
  const ts = nowIso();
  const repo: Repo = {
    id: state.nextRepoId++,
    name,
    description,
    isPrivate,
    defaultBranch: 'main',
    createdAt: ts,
    updatedAt: ts,
    objects: new Map(),
    refs: new Map(),
    commitCache: new Map(),
    treeCache: new Map(),
    labels: new Map(),
    issues: new Map(),
    pulls: new Map(),
    nextNumber: 1,
    nextLabelId: 1,
  };
  state.repos.set(name, repo);
  return repo;
}

/**
 * Find a repo by the (owner, name) a request addressed. The forge has one user: the token owner.
 * Repos are created owner-less through POST /user/repos, so the first request that addresses an
 * existing repo under some owner binds that owner as the viewer login; afterwards any other
 * owner is a 404, exactly as GitHub answers for a repo that is not yours to see.
 */
export function lookupRepo(owner: string, name: string): Repo | null {
  const repo = state.repos.get(name);
  if (!repo) return null;
  if (state.viewerLogin === null) {
    state.viewerLogin = owner;
    return repo;
  }
  return owner === state.viewerLogin ? repo : null;
}

/** Find a repo by name alone (the viewer's own pool: /user/repos, MCP create paths). */
export function repoByName(name: string): Repo | null {
  return state.repos.get(name) ?? null;
}

export function deleteRepo(name: string): boolean {
  return state.repos.delete(name);
}

// ---------------------------------------------------------------------------
// object primitives
// ---------------------------------------------------------------------------

export function hashObject(type: string, data: Buffer): string {
  const head = Buffer.from(`${type} ${data.length}\0`, 'utf8');
  return createHash('sha1').update(head).update(data).digest('hex');
}

export function addObject(repo: Repo, type: string, data: Buffer): string {
  const oid = hashObject(type, data);
  if (!repo.objects.has(oid)) repo.objects.set(oid, { type, data });
  return oid;
}

export function parseCommit(data: Buffer): CommitView {
  const text = data.toString('utf8');
  const split = text.indexOf('\n\n');
  const head = split === -1 ? text : text.slice(0, split);
  const message = split === -1 ? '' : text.slice(split + 2);
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of head.split('\n')) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  return { tree, parents, author, committer, message };
}

export function commitOf(repo: Repo, oid: string): CommitView | null {
  const cached = repo.commitCache.get(oid);
  if (cached) return cached;
  const obj = repo.objects.get(oid);
  if (!obj || obj.type !== 'commit') return null;
  const view = parseCommit(obj.data);
  repo.commitCache.set(oid, view);
  return view;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    const mode = data.subarray(offset, space).toString('ascii');
    const nul = data.indexOf(0x00, space);
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Build a tree object body; entries are sorted the way git sorts them (dirs as name + '/'). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const sorted = [...entries].sort((a, b) => {
    const ka = a.mode === '40000' || a.mode === '040000' ? `${a.name}/` : a.name;
    const kb = b.mode === '40000' || b.mode === '040000' ? `${b.name}/` : b.name;
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
  const parts: Buffer[] = [];
  for (const entry of sorted) {
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export function parseTagTarget(data: Buffer): { object: string; type: string } {
  const text = data.toString('utf8');
  let object = '';
  let type = '';
  for (const line of text.split('\n')) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim();
    else if (line === '') break;
  }
  return { object, type };
}

/** Peel an object id through tag objects to the first non-tag object. */
export function peel(repo: Repo, oid: string): string {
  let current = oid;
  for (let guard = 0; guard < 32; guard += 1) {
    const obj = repo.objects.get(current);
    if (!obj || obj.type !== 'tag') return current;
    current = parseTagTarget(obj.data).object;
  }
  return current;
}

/** Flatten a tree (recursively) into path -> {oid, mode}; cached, trees are immutable. */
export function treeToMap(repo: Repo, treeOid: string | null): Map<string, { oid: string; mode: string }> {
  const out = new Map<string, { oid: string; mode: string }>();
  if (treeOid === null) return out;
  const cached = repo.treeCache.get(treeOid);
  if (cached) return new Map(cached);
  const walk = (oid: string, prefix: string): void => {
    const obj = repo.objects.get(oid);
    if (!obj || obj.type !== 'tree') return;
    for (const entry of parseTree(obj.data)) {
      const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      if (entry.mode === '40000' || entry.mode === '040000') walk(entry.oid, path);
      else out.set(path, { oid: entry.oid, mode: entry.mode });
    }
  };
  walk(treeOid, '');
  repo.treeCache.set(treeOid, new Map(out));
  return out;
}

/** Rebuild a root tree oid from a flat path map, creating every tree object on the way. */
export function mapToTree(repo: Repo, map: Map<string, { oid: string; mode: string }>): string {
  interface Node {
    files: Map<string, { oid: string; mode: string }>;
    dirs: Map<string, Node>;
  }
  const make = (): Node => ({ files: new Map(), dirs: new Map() });
  const root = make();
  for (const [path, entry] of map) {
    const segments = path.split('/');
    let node = root;
    for (let i = 0; i < segments.length - 1; i += 1) {
      if (!node.dirs.has(segments[i])) node.dirs.set(segments[i], make());
      node = node.dirs.get(segments[i])!;
    }
    node.files.set(segments[segments.length - 1], entry);
  }
  const build = (node: Node): string => {
    const entries: TreeEntry[] = [];
    for (const [name, entry] of node.files) entries.push({ mode: entry.mode, name, oid: entry.oid });
    for (const [name, child] of node.dirs) entries.push({ mode: '40000', name, oid: build(child) });
    return addObject(repo, 'tree', buildTree(entries));
  };
  return build(root);
}

/** Create a commit object from parts; the message is stored exactly as given. */
export function makeCommit(
  repo: Repo,
  treeOid: string,
  parents: string[],
  message: string,
  authorName: string,
  authorEmail: string,
  epochSec: number,
): string {
  const ident = `${authorName} <${authorEmail}> ${epochSec} +0000`;
  const lines = [`tree ${treeOid}`];
  for (const parent of parents) lines.push(`parent ${parent}`);
  lines.push(`author ${ident}`);
  lines.push(`committer ${ident}`);
  const data = Buffer.from(`${lines.join('\n')}\n\n${message}`, 'utf8');
  return addObject(repo, 'commit', data);
}

// ---------------------------------------------------------------------------
// reachability
// ---------------------------------------------------------------------------

export interface CollectResult {
  objects: Set<string>;
  /** Included commits whose parent chain was cut (by depth or by a leaf): the shallow boundary. */
  boundary: Set<string>;
  commits: Set<string>;
}

/**
 * Collect every object reachable from `roots`. Commits are walked by generation: a commit is
 * included when its generation is < maxGen. Commits in `leaves` are included but their parents
 * are not walked (a client's existing shallow boundary). Tag objects peel at the same
 * generation as their target.
 */
export function collect(
  repo: Repo,
  roots: Iterable<string>,
  options: { maxGen?: number; leaves?: ReadonlySet<string> } = {},
): CollectResult {
  const maxGen = options.maxGen ?? Number.POSITIVE_INFINITY;
  const leaves = options.leaves ?? new Set<string>();
  const objects = new Set<string>();
  const commits = new Set<string>();
  const boundary = new Set<string>();
  const bestGen = new Map<string, number>();
  const queue: Array<{ oid: string; gen: number }> = [];
  for (const root of roots) queue.push({ oid: root, gen: 0 });
  const addTree = (treeOid: string): void => {
    const stack = [treeOid];
    while (stack.length) {
      const oid = stack.pop()!;
      if (objects.has(oid)) continue;
      const obj = repo.objects.get(oid);
      if (!obj) continue;
      objects.add(oid);
      if (obj.type === 'tree') {
        for (const entry of parseTree(obj.data)) {
          if (entry.mode === '40000' || entry.mode === '040000') stack.push(entry.oid);
          else objects.add(entry.oid);
        }
      }
    }
  };
  while (queue.length) {
    const { oid, gen } = queue.shift()!;
    const obj = repo.objects.get(oid);
    if (!obj) continue;
    if (obj.type === 'tag') {
      objects.add(oid);
      queue.push({ oid: parseTagTarget(obj.data).object, gen });
      continue;
    }
    if (obj.type !== 'commit') {
      objects.add(oid);
      continue;
    }
    const seen = bestGen.get(oid);
    if (seen !== undefined && seen <= gen) continue;
    bestGen.set(oid, gen);
    if (gen >= maxGen) continue;
    commits.add(oid);
    objects.add(oid);
    const view = commitOf(repo, oid);
    if (!view) continue;
    addTree(view.tree);
    if (leaves.has(oid)) {
      if (view.parents.some((parent) => repo.objects.has(parent))) boundary.add(oid);
      continue;
    }
    for (const parent of view.parents) {
      if (gen + 1 < maxGen) queue.push({ oid: parent, gen: gen + 1 });
      else if (repo.objects.has(parent)) boundary.add(oid);
    }
  }
  return { objects, boundary, commits };
}

/** True when `ancestor` is `descendant` itself or reachable from it through parent links. */
export function isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
  if (ancestor === descendant) return true;
  const seen = new Set<string>();
  const stack = [descendant];
  while (stack.length) {
    const oid = stack.pop()!;
    if (oid === ancestor) return true;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const view = commitOf(repo, oid);
    if (view) for (const parent of view.parents) stack.push(parent);
  }
  return false;
}

/** The best common ancestor of two commits, or null when they share no history. */
export function mergeBase(repo: Repo, a: string, b: string): string | null {
  if (a === b) return a;
  const ancestors = new Set<string>();
  const stack = [a];
  while (stack.length) {
    const oid = stack.pop()!;
    if (ancestors.has(oid)) continue;
    ancestors.add(oid);
    const view = commitOf(repo, oid);
    if (view) for (const parent of view.parents) stack.push(parent);
  }
  const seen = new Set<string>();
  const queue = [b];
  while (queue.length) {
    const oid = queue.shift()!;
    if (ancestors.has(oid)) return oid;
    if (seen.has(oid)) continue;
    seen.add(oid);
    const view = commitOf(repo, oid);
    if (view) for (const parent of view.parents) queue.push(parent);
  }
  return null;
}

/** Commits reachable from `tip`, newest first (DFS pre-order over parents, de-duplicated). */
export function listCommits(repo: Repo, tip: string, limit = 1000): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  const stack = [tip];
  while (stack.length && out.length < limit) {
    const oid = stack.pop()!;
    if (seen.has(oid)) continue;
    const view = commitOf(repo, oid);
    if (!view) continue;
    seen.add(oid);
    out.push(oid);
    for (let i = view.parents.length - 1; i >= 0; i -= 1) stack.push(view.parents[i]);
  }
  return out;
}

// ---------------------------------------------------------------------------
// diffs and merges over trees
// ---------------------------------------------------------------------------

export interface FileDiff {
  path: string;
  status: string; // 'added' | 'modified' | 'removed'
  baseOid: string | null;
  headOid: string | null;
  additions: number;
  deletions: number;
}

/** Line-change counts between two texts: an LCS diff, with a coarse fallback for huge files. */
export function lineCounts(oldText: string, newText: string): { additions: number; deletions: number } {
  if (oldText === newText) return { additions: 0, deletions: 0 };
  const oldLines = oldText === '' ? [] : oldText.split('\n');
  const newLines = newText === '' ? [] : newText.split('\n');
  if (oldLines.length * newLines.length > 4_000_000) {
    return { additions: newLines.length, deletions: oldLines.length };
  }
  const m = oldLines.length;
  const n = newLines.length;
  const dp = new Array<number>((m + 1) * (n + 1)).fill(0);
  for (let i = m - 1; i >= 0; i -= 1) {
    for (let j = n - 1; j >= 0; j -= 1) {
      dp[i * (n + 1) + j] = oldLines[i] === newLines[j]
        ? dp[(i + 1) * (n + 1) + j + 1] + 1
        : Math.max(dp[(i + 1) * (n + 1) + j], dp[i * (n + 1) + j + 1]);
    }
  }
  const common = dp[0];
  return { additions: n - common, deletions: m - common };
}

function blobText(repo: Repo, oid: string | null): string {
  if (oid === null) return '';
  const obj = repo.objects.get(oid);
  return obj ? obj.data.toString('utf8') : '';
}

/** The file-level diff between two flat path maps. */
export function diffMaps(
  repo: Repo,
  baseMap: Map<string, { oid: string; mode: string }>,
  headMap: Map<string, { oid: string; mode: string }>,
): FileDiff[] {
  const out: FileDiff[] = [];
  const paths = new Set<string>([...baseMap.keys(), ...headMap.keys()]);
  for (const path of [...paths].sort()) {
    const base = baseMap.get(path);
    const head = headMap.get(path);
    if (base && head && base.oid === head.oid) continue;
    const status = !base ? 'added' : !head ? 'removed' : 'modified';
    const counts = lineCounts(blobText(repo, base?.oid ?? null), blobText(repo, head?.oid ?? null));
    out.push({
      path,
      status,
      baseOid: base?.oid ?? null,
      headOid: head?.oid ?? null,
      additions: counts.additions,
      deletions: counts.deletions,
    });
  }
  return out;
}

/**
 * Three-way merge of flat path maps. Returns the merged map, or the first conflicting path.
 * A path conflicts when both sides changed it away from the base in different ways.
 */
export function mergeMaps(
  baseMap: Map<string, { oid: string; mode: string }>,
  oursMap: Map<string, { oid: string; mode: string }>,
  theirsMap: Map<string, { oid: string; mode: string }>,
): { merged: Map<string, { oid: string; mode: string }> } | { conflict: string } {
  const merged = new Map<string, { oid: string; mode: string }>();
  const paths = new Set<string>([...baseMap.keys(), ...oursMap.keys(), ...theirsMap.keys()]);
  for (const path of paths) {
    const base = baseMap.get(path);
    const ours = oursMap.get(path);
    const theirs = theirsMap.get(path);
    const sameOid = (x?: { oid: string }, y?: { oid: string }): boolean => (x?.oid ?? null) === (y?.oid ?? null);
    let pick: { oid: string; mode: string } | undefined;
    if (sameOid(ours, theirs)) pick = ours;
    else if (sameOid(base, ours)) pick = theirs;
    else if (sameOid(base, theirs)) pick = ours;
    else return { conflict: path };
    if (pick) merged.set(path, pick);
  }
  return { merged };
}

/** The tree oid a commit names (empty tree when the commit is unknown). */
export function commitTreeOid(repo: Repo, commitOid: string | null): string | null {
  if (commitOid === null) return null;
  const view = commitOf(repo, commitOid);
  return view ? view.tree : null;
}

/** The flat file map at a commit (empty when the commit is unknown). */
export function commitMap(repo: Repo, commitOid: string | null): Map<string, { oid: string; mode: string }> {
  return treeToMap(repo, commitTreeOid(repo, commitOid));
}
