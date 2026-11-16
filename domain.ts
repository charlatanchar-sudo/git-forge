// Domain operations shared by the REST, GraphQL and MCP surfaces: issue/pull creation,
// pull-request diffs, mergeability and merges (squash and merge commits over the object store).

import {
  commitMap,
  diffMaps,
  makeCommit,
  mapToTree,
  mergeBase,
  mergeMaps,
  nextSeq,
  nowIso,
  peel,
  state,
  viewerLogin,
  type FileDiff,
  type IssueRec,
  type PullRec,
  type Repo,
} from './core.ts';

export function newIssue(repo: Repo, title: string, body: string, labels: string[]): IssueRec {
  const ts = nowIso();
  const issue: IssueRec = {
    id: state.nextIssueId++,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    labels: [...labels],
    comments: [],
    createdAt: ts,
    updatedAt: ts,
    closedAt: null,
    seq: nextSeq(),
  };
  repo.issues.set(issue.number, issue);
  return issue;
}

export function newPull(repo: Repo, title: string, body: string, head: string, base: string): PullRec {
  const ts = nowIso();
  const pull: PullRec = {
    id: state.nextIssueId++,
    number: repo.nextNumber++,
    title,
    body,
    state: 'open',
    head,
    base,
    merged: false,
    mergedAt: null,
    mergeCommitSha: null,
    createdAt: ts,
    updatedAt: ts,
    closedAt: null,
    seq: nextSeq(),
  };
  repo.pulls.set(pull.number, pull);
  return pull;
}

export function addComment(repo: Repo, issue: IssueRec, body: string): IssueRec['comments'][number] {
  const ts = nowIso();
  const comment = { id: state.nextCommentId++, body, createdAt: ts, updatedAt: ts, seq: nextSeq() };
  issue.comments.push(comment);
  issue.updatedAt = ts;
  void repo;
  return comment;
}

/** The commit a branch ref names (peeling tags), or null when the branch does not exist. */
export function branchTip(repo: Repo, branch: string): string | null {
  const oid = repo.refs.get(`refs/heads/${branch}`);
  if (!oid) return null;
  return peel(repo, oid);
}

/** The files a pull request changes: merge-base tree versus head tree (GitHub's three-dot diff). */
export function pullDiffFiles(repo: Repo, pull: PullRec): FileDiff[] {
  const baseTip = branchTip(repo, pull.base);
  const headTip = branchTip(repo, pull.head);
  if (!baseTip || !headTip) return [];
  const base = mergeBase(repo, baseTip, headTip) ?? baseTip;
  return diffMaps(repo, commitMap(repo, base), commitMap(repo, headTip));
}

interface MergePlan {
  treeMap: Map<string, { oid: string; mode: string }>;
  baseTip: string;
  headTip: string;
}

function planMerge(repo: Repo, pull: PullRec): MergePlan | { conflict: string } | null {
  const baseTip = branchTip(repo, pull.base);
  const headTip = branchTip(repo, pull.head);
  if (!baseTip || !headTip) return null;
  const base = mergeBase(repo, baseTip, headTip);
  const result = mergeMaps(
    commitMap(repo, base),
    commitMap(repo, baseTip),
    commitMap(repo, headTip),
  );
  if ('conflict' in result) return { conflict: result.conflict };
  return { treeMap: result.merged, baseTip, headTip };
}

export function pullMergeable(repo: Repo, pull: PullRec): string {
  if (pull.state !== 'open') return 'UNKNOWN';
  const plan = planMerge(repo, pull);
  if (plan === null) return 'UNKNOWN';
  return 'conflict' in plan ? 'CONFLICTING' : 'MERGEABLE';
}

export type MergeOutcome =
  | { ok: true; sha: string }
  | { ok: false; reason: 'conflict' | 'not-mergeable' | 'missing' };

/** Merge a pull request into its base branch: a squash commit, or a two-parent merge commit. */
export function mergePull(repo: Repo, pull: PullRec, method: string): MergeOutcome {
  if (pull.state !== 'open') return { ok: false, reason: 'not-mergeable' };
  const plan = planMerge(repo, pull);
  if (plan === null) return { ok: false, reason: 'missing' };
  if ('conflict' in plan) return { ok: false, reason: 'conflict' };
  const treeOid = mapToTree(repo, plan.treeMap);
  const login = viewerLogin();
  const epoch = Math.floor(Date.now() / 1000);
  let sha: string;
  if (method === 'merge') {
    sha = makeCommit(
      repo,
      treeOid,
      [plan.baseTip, plan.headTip],
      `Merge pull request #${pull.number} from ${pull.head}\n\n${pull.title}`,
      login,
      `${login}@users.noreply.github.com`,
      epoch,
    );
  } else {
    sha = makeCommit(
      repo,
      treeOid,
      [plan.baseTip],
      `${pull.title} (#${pull.number})`,
      login,
      `${login}@users.noreply.github.com`,
      epoch,
    );
  }
  repo.refs.set(`refs/heads/${pull.base}`, sha);
  pull.state = 'closed';
  pull.merged = true;
  pull.mergedAt = nowIso();
  pull.closedAt = pull.mergedAt;
  pull.updatedAt = pull.mergedAt;
  pull.mergeCommitSha = sha;
  return { ok: true, sha };
}
