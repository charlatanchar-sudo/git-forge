// The forge's HTTP surface: GitHub REST v3, git smart HTTP routing, GraphQL v4 and the MCP
// endpoint, all over the shared in-memory store in core.ts. One process, node:http only.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import {
  ZERO_OID,
  addObject,
  commitMap,
  commitOf,
  createRepo,
  deleteRepo,
  listCommits,
  lookupRepo,
  makeCommit,
  mapToTree,
  nowIso,
  parseTree,
  peel,
  repoByName,
  state,
  treeToMap,
  viewerLogin,
  type IssueRec,
  type PullRec,
  type Repo,
} from './core.ts';
import { addComment, branchTip, mergePull, newIssue, newPull, pullDiffFiles } from './domain.ts';
import { receivePack, uploadPack, v0Advertisement, v2Advertisement } from './gitp.ts';
import { executeGraphQL } from './gql.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `forge-${requestCounter.toString(16).padStart(8, '0')}`;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  headers: Readonly<Record<string, string>> = {},
): void {
  const text = body === undefined ? '' : `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': JSON_TYPE,
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...headers,
  });
  res.end(text);
}

function sendRaw(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function notFound(res: ServerResponse): void {
  sendJson(res, 404, { message: 'Not Found' });
}

function validationFailed(res: ServerResponse, message = 'Validation Failed'): void {
  sendJson(res, 422, { message, errors: [] });
}

// ---------------------------------------------------------------------------
// auth: the env presents Bearer $MAKEFUN_SHOP_TOKEN on every API call
// ---------------------------------------------------------------------------

function authed(req: IncomingMessage): boolean {
  const header = req.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return false;
  const token = header.slice('Bearer '.length);
  if (token === '') return false;
  const expected = process.env.MAKEFUN_SHOP_TOKEN;
  return expected ? token === expected : true;
}

// ---------------------------------------------------------------------------
// JSON views
// ---------------------------------------------------------------------------

function baseOf(req: IncomingMessage): string {
  const host = req.headers.host ?? '127.0.0.1';
  return `http://${host}`;
}

function userJson(): Record<string, unknown> {
  const login = viewerLogin();
  return {
    login,
    id: 1,
    node_id: Buffer.from(`User:1`).toString('base64'),
    avatar_url: 'https://forge.local/avatar.png',
    gravatar_id: '',
    url: `https://forge.local/api/v3/users/${login}`,
    html_url: `https://forge.local/${login}`,
    type: 'User',
    site_admin: false,
  };
}

function ownerJson(): Record<string, unknown> {
  const login = viewerLogin();
  return {
    login,
    id: 1,
    node_id: Buffer.from(`User:1`).toString('base64'),
    avatar_url: 'https://forge.local/avatar.png',
    gravatar_id: '',
    url: `https://forge.local/api/v3/users/${login}`,
    html_url: `https://forge.local/${login}`,
    type: 'User',
    site_admin: false,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  const login = viewerLogin();
  const fullName = `${login}/${repo.name}`;
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length
    + [...repo.pulls.values()].filter((p) => p.state === 'open').length;
  return {
    id: repo.id,
    node_id: Buffer.from(`Repository:${repo.id}`).toString('base64'),
    name: repo.name,
    full_name: fullName,
    owner: ownerJson(),
    private: repo.isPrivate,
    html_url: `https://forge.local/${fullName}`,
    description: repo.description,
    fork: false,
    url: `https://forge.local/api/v3/repos/${fullName}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    git_url: `git://forge.local/${fullName}.git`,
    ssh_url: `git@forge.local:${fullName}.git`,
    clone_url: `https://forge.local/${fullName}.git`,
    homepage: null,
    size: 0,
    stargazers_count: 0,
    watchers_count: 0,
    language: null,
    has_issues: true,
    has_projects: true,
    has_downloads: true,
    has_wiki: true,
    has_pages: false,
    forks_count: 0,
    mirror_url: null,
    archived: false,
    disabled: false,
    open_issues_count: openIssues,
    license: null,
    allow_forking: true,
    is_template: false,
    topics: [],
    visibility: repo.isPrivate ? 'private' : 'public',
    forks: 0,
    open_issues: openIssues,
    watchers: 0,
    default_branch: repo.defaultBranch,
    permissions: { admin: true, maintain: true, push: true, triage: true, pull: true },
  };
}

function labelJson(repo: Repo, name: string): Record<string, unknown> {
  const label = repo.labels.get(name);
  return {
    id: label?.id ?? 0,
    node_id: Buffer.from(`Label:${name}`).toString('base64'),
    url: `https://forge.local/api/v3/repos/${viewerLogin()}/${repo.name}/labels/${encodeURIComponent(name)}`,
    name,
    color: label?.color ?? 'ededed',
    default: false,
    description: label?.description ?? null,
  };
}

export function issueJson(repo: Repo, issue: IssueRec): Record<string, unknown> {
  const login = viewerLogin();
  const fullName = `${login}/${repo.name}`;
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.id}:${issue.number}`).toString('base64'),
    url: `https://forge.local/api/v3/repos/${fullName}/issues/${issue.number}`,
    repository_url: `https://forge.local/api/v3/repos/${fullName}`,
    labels_url: `https://forge.local/api/v3/repos/${fullName}/issues/${issue.number}/labels{/name}`,
    comments_url: `https://forge.local/api/v3/repos/${fullName}/issues/${issue.number}/comments`,
    events_url: `https://forge.local/api/v3/repos/${fullName}/issues/${issue.number}/events`,
    html_url: `https://forge.local/${fullName}/issues/${issue.number}`,
    number: issue.number,
    state: issue.state,
    title: issue.title,
    body: issue.body,
    user: userJson(),
    labels: issue.labels.map((name) => labelJson(repo, name)),
    assignee: null,
    assignees: [],
    milestone: null,
    locked: false,
    active_lock_reason: null,
    comments: issue.comments.length,
    closed_at: issue.closedAt,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    author_association: 'OWNER',
  };
}

function commentJson(repo: Repo, issue: IssueRec, comment: IssueRec['comments'][number]): Record<string, unknown> {
  const login = viewerLogin();
  const fullName = `${login}/${repo.name}`;
  return {
    id: comment.id,
    node_id: Buffer.from(`IssueComment:${comment.id}`).toString('base64'),
    url: `https://forge.local/api/v3/repos/${fullName}/issues/comments/${comment.id}`,
    html_url: `https://forge.local/${fullName}/issues/${issue.number}#issuecomment-${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
    issue_url: `https://forge.local/api/v3/repos/${fullName}/issues/${issue.number}`,
    author_association: 'OWNER',
  };
}

export function pullJson(repo: Repo, pull: PullRec): Record<string, unknown> {
  const login = viewerLogin();
  const fullName = `${login}/${repo.name}`;
  const headTip = branchTip(repo, pull.head);
  const baseTipValue = branchTip(repo, pull.base);
  const side = (ref: string, tip: string | null): Record<string, unknown> => ({
    label: `${login}:${ref}`,
    ref,
    sha: tip ?? ZERO_OID,
    user: userJson(),
    repo: repoJson(repo),
  });
  return {
    id: pull.id,
    node_id: Buffer.from(`PullRequest:${repo.id}:${pull.number}`).toString('base64'),
    url: `https://forge.local/api/v3/repos/${fullName}/pulls/${pull.number}`,
    html_url: `https://forge.local/${fullName}/pull/${pull.number}`,
    diff_url: `https://forge.local/${fullName}/pull/${pull.number}.diff`,
    patch_url: `https://forge.local/${fullName}/pull/${pull.number}.patch`,
    number: pull.number,
    state: pull.state,
    locked: false,
    title: pull.title,
    body: pull.body,
    user: userJson(),
    labels: [],
    milestone: null,
    active_lock_reason: null,
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.closedAt,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    assignee: null,
    assignees: [],
    requested_reviewers: [],
    requested_teams: [],
    head: side(pull.head, headTip),
    base: side(pull.base, baseTipValue),
    author_association: 'OWNER',
    auto_merge: null,
    draft: false,
    merged: pull.merged,
    mergeable: null,
    rebaseable: null,
    mergeable_state: 'unknown',
    merged_by: pull.merged ? userJson() : null,
    comments: 0,
    review_comments: 0,
    maintainer_can_modify: false,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function parseIdent(line: string): { name: string; email: string; date: string } {
  const match = /^(.*) <(.*)> (\d+) [+-]\d{4}$/.exec(line);
  if (!match) return { name: line, email: '', date: new Date(0).toISOString() };
  return { name: match[1], email: match[2], date: new Date(Number(match[3]) * 1000).toISOString() };
}

export function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const view = commitOf(repo, oid);
  if (!view) return null;
  const login = viewerLogin();
  const fullName = `${login}/${repo.name}`;
  return {
    sha: oid,
    node_id: Buffer.from(`Commit:${oid}`).toString('base64'),
    commit: {
      author: parseIdent(view.author),
      committer: parseIdent(view.committer),
      message: view.message.replace(/\n+$/, ''),
      tree: { sha: view.tree, url: `https://forge.local/api/v3/repos/${fullName}/git/trees/${view.tree}` },
      url: `https://forge.local/api/v3/repos/${fullName}/git/commits/${oid}`,
      comment_count: 0,
    },
    url: `https://forge.local/api/v3/repos/${fullName}/commits/${oid}`,
    html_url: `https://forge.local/${fullName}/commit/${oid}`,
    comments_url: `https://forge.local/api/v3/repos/${fullName}/commits/${oid}/comments`,
    author: userJson(),
    committer: userJson(),
    parents: view.parents.map((parent) => ({
      sha: parent,
      url: `https://forge.local/api/v3/repos/${fullName}/commits/${parent}`,
      html_url: `https://forge.local/${fullName}/commit/${parent}`,
    })),
  };
}

// ---------------------------------------------------------------------------
// pagination (GitHub's Link header chain)
// ---------------------------------------------------------------------------

function paginate<T>(
  req: IncomingMessage,
  res: ServerResponse,
  rawPath: string,
  query: URLSearchParams,
  items: T[],
  status = 200,
): void {
  const perPageRaw = Number.parseInt(query.get('per_page') ?? '', 10);
  const perPage = Number.isFinite(perPageRaw) && perPageRaw > 0 ? Math.min(perPageRaw, 100) : 30;
  const pageRaw = Number.parseInt(query.get('page') ?? '', 10);
  const page = Number.isFinite(pageRaw) && pageRaw > 0 ? pageRaw : 1;
  const totalPages = Math.max(1, Math.ceil(items.length / perPage));
  const slice = items.slice((page - 1) * perPage, page * perPage);
  const headers: Record<string, string> = {};
  if (items.length > perPage) {
    const urlFor = (p: number): string => {
      const params = new URLSearchParams(query);
      params.set('per_page', String(perPage));
      params.set('page', String(p));
      return `<${baseOf(req)}${rawPath}?${params.toString()}>`;
    };
    const links: string[] = [];
    if (page < totalPages) {
      links.push(`${urlFor(page + 1)}; rel="next"`);
      links.push(`${urlFor(totalPages)}; rel="last"`);
    }
    if (page > 1) {
      links.push(`${urlFor(1)}; rel="first"`);
      links.push(`${urlFor(page - 1)}; rel="prev"`);
    }
    if (links.length) headers.link = links.join(', ');
  }
  sendJson(res, status, slice, headers);
}

// ---------------------------------------------------------------------------
// contents commits: REST writes are real git commits on the object store
// ---------------------------------------------------------------------------

function commitOnBranch(
  repo: Repo,
  branch: string,
  map: Map<string, { oid: string; mode: string }>,
  message: string,
  parentTip: string | null,
): string {
  const treeOid = mapToTree(repo, map);
  const login = viewerLogin();
  const commitOid = makeCommit(
    repo,
    treeOid,
    parentTip ? [parentTip] : [],
    message,
    login,
    `${login}@users.noreply.github.com`,
    Math.floor(Date.now() / 1000),
  );
  repo.refs.set(`refs/heads/${branch}`, commitOid);
  repo.updatedAt = nowIso();
  return commitOid;
}

/** The tip a contents write builds on: the branch's own tip, or the default branch's for a new branch. */
function contentsBaseTip(repo: Repo, branch: string): string | null {
  const own = repo.refs.get(`refs/heads/${branch}`);
  if (own) return own;
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
}

// ---------------------------------------------------------------------------
// REST routing
// ---------------------------------------------------------------------------

interface RestRequest {
  req: IncomingMessage;
  res: ServerResponse;
  segments: string[];
  query: URLSearchParams;
  rawPath: string;
  body: Buffer;
}

function jsonBody(r: RestRequest): Record<string, unknown> | null {
  if (r.body.length === 0) return {};
  try {
    const parsed = JSON.parse(r.body.toString('utf8')) as unknown;
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return null;
  }
}

function restRoot(r: RestRequest): void {
  const base = `${baseOf(r.req)}/api/v3`;
  sendJson(r.res, 200, {
    current_user_url: `${base}/user`,
    current_user_authorizations_html_url: `${baseOf(r.req)}/settings/connections/applications`,
    authorizations_url: `${base}/authorizations`,
    code_search_url: `${base}/search/code?q={query}{&page,per_page,sort,order}`,
    commit_search_url: `${base}/search/commits?q={query}{&page,per_page,sort,order}`,
    emails_url: `${base}/user/emails`,
    emojis_url: `${base}/emojis`,
    events_url: `${base}/events`,
    feeds_url: `${base}/feeds`,
    followers_url: `${base}/user/followers`,
    following_url: `${base}/user/following{/target}`,
    gists_url: `${base}/gists{/gist_id}`,
    hub_url: `${base}/hub`,
    issue_search_url: `${base}/search/issues?q={query}{&page,per_page,sort,order}`,
    issues_url: `${base}/issues`,
    keys_url: `${base}/user/keys`,
    label_search_url: `${base}/search/labels?q={query}&repository_id={repository_id}{&page,per_page}`,
    notifications_url: `${base}/notifications`,
    organization_url: `${base}/orgs/{org}`,
    organization_repositories_url: `${base}/orgs/{org}/repos{?type,page,per_page,sort}`,
    organization_teams_url: `${base}/orgs/{org}/teams`,
    public_gists_url: `${base}/gists/public`,
    rate_limit_url: `${base}/rate_limit`,
    repository_url: `${base}/repos/{owner}/{repo}`,
    repository_search_url: `${base}/search/repositories?q={query}{&page,per_page,sort,order}`,
    current_user_repositories_url: `${base}/user/repos{?type,page,per_page,sort}`,
    starred_url: `${base}/user/starred{/owner}{/repo}`,
    teams_url: `${base}/teams`,
    user_url: `${base}/users/{user}`,
    user_organizations_url: `${base}/users/{user}/orgs`,
    user_repositories_url: `${base}/users/{user}/repos{?type,page,per_page,sort}`,
    user_search_url: `${base}/search/users?q={query}{&page,per_page,sort,order}`,
  }, { 'x-oauth-scopes': 'repo, read:org' });
}

function handleRest(r: RestRequest): void {
  const { req, res, segments } = r;
  const method = req.method ?? 'GET';

  // The API root is the one unauthenticated read (as on api.github.com).
  if (segments.length === 0) {
    if (method === 'GET') return restRoot(r);
    return notFound(res);
  }

  if (!authed(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }

  if (segments[0] === 'meta' && segments.length === 1) {
    if (method !== 'GET') return notFound(res);
    return sendJson(res, 200, {
      verifiable_password_authentication: true,
      ssh_key_fingerprints: { SHA256_RSA: '', SHA256_ECDSA: '', SHA256_ED25519: '' },
      ssh_keys: [],
      hooks: [],
      web: [],
      api: [],
      git: [],
      packages: [],
      pages: [],
      importer: [],
      actions: [],
      dependabot: [],
      installed_version: '3.10.0',
    });
  }

  if (segments[0] === 'rate_limit' && segments.length === 1) {
    return sendJson(res, 200, {
      resources: { core: { limit: 5000, used: 1, remaining: 4999, reset: 1893456000 }, search: { limit: 30, used: 0, remaining: 30, reset: 1893456000 } },
      rate: { limit: 5000, used: 1, remaining: 4999, reset: 1893456000 },
    });
  }

  if (segments[0] === 'user' && segments.length === 1) {
    if (method !== 'GET') return notFound(res);
    if (state.viewerLogin === null) return notFound(res);
    return sendJson(res, 200, userJson());
  }

  if (segments[0] === 'user' && segments[1] === 'repos' && segments.length === 2) {
    if (method === 'GET') {
      const repos = [...state.repos.values()].sort((a, b) => a.id - b.id).map((repo) => repoJson(repo));
      return paginate(req, res, r.rawPath, r.query, repos);
    }
    if (method === 'POST') {
      const body = jsonBody(r);
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const name = typeof body.name === 'string' ? body.name : '';
      if (name === '' || !/^[A-Za-z0-9._-]+$/.test(name)) return validationFailed(res);
      if (repoByName(name)) {
        return sendJson(res, 422, {
          message: 'name already exists on this account',
          errors: [{ resource: 'Repository', field: 'name', code: 'custom' }],
        });
      }
      const repo = createRepo(
        name,
        typeof body.description === 'string' ? body.description : null,
        body.private === true,
      );
      if (!repo) return validationFailed(res);
      if (body.auto_init === true) {
        const blob = addObject(repo, 'blob', Buffer.from(`# ${name}\n`, 'utf8'));
        const map = new Map([['README.md', { oid: blob, mode: '100644' }]]);
        commitOnBranch(repo, repo.defaultBranch, map, 'Initial commit', null);
      }
      return sendJson(res, 201, repoJson(repo));
    }
    return notFound(res);
  }

  if (segments[0] === 'repos' && segments.length >= 3) {
    const owner = segments[1];
    const name = segments[2];
    const repo = lookupRepo(owner, name);
    if (!repo) return notFound(res);
    return handleRepo(r, repo, segments.slice(3));
  }

  return notFound(res);
}

function handleRepo(r: RestRequest, repo: Repo, rest: string[]): void {
  const { req, res } = r;
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') return sendJson(res, 200, repoJson(repo));
    if (method === 'PATCH') {
      const body = jsonBody(r);
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      if (typeof body.description === 'string' || body.description === null) repo.description = body.description;
      if (typeof body.private === 'boolean') repo.isPrivate = body.private;
      if (typeof body.default_branch === 'string' && body.default_branch !== '') {
        if (repo.refs.has(`refs/heads/${body.default_branch}`) || repo.refs.size === 0) {
          repo.defaultBranch = body.default_branch;
        }
      }
      if (typeof body.homepage === 'string') { /* accepted, not modelled */ }
      repo.updatedAt = nowIso();
      return sendJson(res, 200, repoJson(repo));
    }
    if (method === 'DELETE') {
      deleteRepo(repo.name);
      res.writeHead(204, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    return notFound(res);
  }

  const head = rest[0];

  if (head === 'branches') {
    if (rest.length === 1 && method === 'GET') {
      const branches = [...repo.refs.entries()]
        .filter(([ref]) => ref.startsWith('refs/heads/'))
        .map(([ref, oid]) => ({
          name: ref.slice('refs/heads/'.length),
          commit: { sha: oid, url: `https://forge.local/api/v3/repos/${viewerLogin()}/${repo.name}/commits/${oid}` },
          protected: false,
        }))
        .sort((a, b) => (a.name < b.name ? -1 : 1));
      return paginate(req, res, r.rawPath, r.query, branches);
    }
    if (rest.length >= 2 && method === 'GET') {
      const branch = rest.slice(1).join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (!oid) return notFound(res);
      return sendJson(res, 200, {
        name: branch,
        commit: { sha: oid, url: `https://forge.local/api/v3/repos/${viewerLogin()}/${repo.name}/commits/${oid}` },
        protected: false,
      });
    }
    return notFound(res);
  }

  if (head === 'commits') {
    if (rest.length === 1 && method === 'GET') {
      const shaParam = r.query.get('sha');
      let tip: string | null = null;
      if (shaParam) {
        tip = repo.refs.get(`refs/heads/${shaParam}`) ?? repo.refs.get(shaParam)
          ?? (/^[0-9a-f]{40}$/.test(shaParam) && commitOf(repo, shaParam) ? shaParam : null);
      } else {
        tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
      }
      if (!tip) return sendJson(res, 409, { message: 'Git Repository is empty' });
      const commits = listCommits(repo, tip, 1000)
        .map((oid) => commitJson(repo, oid))
        .filter((entry) => entry !== null);
      return paginate(req, res, r.rawPath, r.query, commits);
    }
    if (rest.length === 2 && method === 'GET') {
      const commit = commitJson(repo, rest[1]);
      if (!commit) return notFound(res);
      return sendJson(res, 200, commit);
    }
    return notFound(res);
  }

  if (head === 'contents') {
    return handleContents(r, repo, rest.slice(1).join('/'));
  }

  if (head === 'git') {
    return handleGitData(r, repo, rest.slice(1));
  }

  if (head === 'labels') {
    if (rest.length === 1) {
      if (method === 'GET') {
        const labels = [...repo.labels.keys()].sort().map((name) => labelJson(repo, name));
        return paginate(req, res, r.rawPath, r.query, labels);
      }
      if (method === 'POST') {
        const body = jsonBody(r);
        if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
        const name = typeof body.name === 'string' ? body.name : '';
        if (name === '') return validationFailed(res);
        if (repo.labels.has(name)) return validationFailed(res);
        const color = typeof body.color === 'string' ? body.color.replace(/^#/, '') : 'ededed';
        repo.labels.set(name, {
          id: repo.nextLabelId++,
          name,
          color,
          description: typeof body.description === 'string' ? body.description : null,
        });
        return sendJson(res, 201, labelJson(repo, name));
      }
      return notFound(res);
    }
    if (rest.length === 2 && method === 'GET') {
      if (!repo.labels.has(rest[1])) return notFound(res);
      return sendJson(res, 200, labelJson(repo, rest[1]));
    }
    return notFound(res);
  }

  if (head === 'issues') {
    return handleIssues(r, repo, rest.slice(1));
  }

  if (head === 'pulls') {
    return handlePulls(r, repo, rest.slice(1));
  }

  return notFound(res);
}

// ---------------------------------------------------------------------------
// contents API
// ---------------------------------------------------------------------------

/** Resolve a `ref` parameter (branch, ref, or commit oid) to a commit oid. */
function resolveCommitRef(repo: Repo, refParam: string | null): string | null {
  if (refParam === null || refParam === '') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const byBranch = repo.refs.get(`refs/heads/${refParam}`);
  if (byBranch) return peel(repo, byBranch, 'commit');
  const byRef = repo.refs.get(refParam);
  if (byRef) return peel(repo, byRef, 'commit');
  if (/^[0-9a-f]{40}$/.test(refParam) && commitOf(repo, refParam)) return refParam;
  return null;
}

/** Walk a commit's tree to `path`; returns the entry kind/oid or null. */
function treeEntryAt(
  repo: Repo,
  treeOid: string,
  path: string,
): { kind: 'blob' | 'tree'; oid: string; mode: string } | null {
  if (path === '') return { kind: 'tree', oid: treeOid, mode: '040000' };
  const parts = path.split('/');
  let current = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const treeObj = repo.objects.get(current);
    if (!treeObj || treeObj.type !== 'tree') return null;
    const entries = parseTree(treeObj.data);
    const entry = entries.find((e) => e.name === parts[i]);
    if (!entry) return null;
    if (i === parts.length - 1) {
      return { kind: entry.mode === '40000' ? 'tree' : 'blob', oid: entry.oid, mode: entry.mode };
    }
    if (entry.mode !== '40000') return null;
    current = entry.oid;
  }
  return null;
}

function handleContents(r: RestRequest, repo: Repo, path: string): void {
  const { req, res } = r;
  const method = req.method ?? 'GET';
  const login = viewerLogin();
  const fullName = `${login}/${repo.name}`;
  const cleanPath = path.replace(/^\/+|\/+$/g, '');

  if (method === 'GET') {
    const commitOid = resolveCommitRef(repo, r.query.get('ref'));
    if (!commitOid) return sendJson(res, 404, { message: 'Not Found' });
    const view = commitOf(repo, commitOid);
    if (!view) return notFound(res);
    const found = treeEntryAt(repo, view.tree, cleanPath);
    if (!found) return notFound(res);
    const name = cleanPath === '' ? '' : cleanPath.split('/').pop() as string;
    if (found.kind === 'blob') {
      const obj = repo.objects.get(found.oid);
      const data = obj?.data ?? Buffer.alloc(0);
      return sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name,
        path: cleanPath,
        content: data.toString('base64'),
        sha: found.oid,
        url: `https://forge.local/api/v3/repos/${fullName}/contents/${cleanPath}`,
        git_url: `https://forge.local/api/v3/repos/${fullName}/git/blobs/${found.oid}`,
        html_url: `https://forge.local/${fullName}/blob/${repo.defaultBranch}/${cleanPath}`,
        download_url: `https://forge.local/${fullName}/raw/${cleanPath}`,
        _links: {},
      });
    }
    const dirObj = repo.objects.get(found.oid);
    const entries = parseTree(dirObj?.data ?? Buffer.alloc(0)).map((entry) => {
      const childPath = cleanPath === '' ? entry.name : `${cleanPath}/${entry.name}`;
      const isDir = entry.mode === '40000';
      return {
        type: isDir ? 'dir' : 'file',
        size: isDir ? 0 : (repo.objects.get(entry.oid)?.data.length ?? 0),
        name: entry.name,
        path: childPath,
        sha: entry.oid,
        url: `https://forge.local/api/v3/repos/${fullName}/contents/${childPath}`,
        git_url: `https://forge.local/api/v3/repos/${fullName}/git/${isDir ? 'trees' : 'blobs'}/${entry.oid}`,
        html_url: `https://forge.local/${fullName}/${isDir ? 'tree' : 'blob'}/${repo.defaultBranch}/${childPath}`,
        download_url: isDir ? null : `https://forge.local/${fullName}/raw/${childPath}`,
        _links: {},
      };
    });
    return paginate(req, res, r.rawPath, r.query, entries, 200);
  }

  if (method === 'PUT') {
    const body = jsonBody(r);
    if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
    if (cleanPath === '') return validationFailed(res);
    const message = typeof body.message === 'string' ? body.message : '';
    const contentB64 = typeof body.content === 'string' ? body.content : null;
    if (message === '' || contentB64 === null) return validationFailed(res);
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const baseTip = contentsBaseTip(repo, branch);
    const map = baseTip ? commitMap(repo, baseTip) : new Map<string, { oid: string; mode: string }>();
    const existing = map.get(cleanPath);
    if (existing && body.sha === undefined) {
      return sendJson(res, 422, { message: '"sha" wasn\'t supplied' });
    }
    if (existing && typeof body.sha === 'string' && body.sha !== existing.oid) {
      return sendJson(res, 409, { message: `${cleanPath} does not match ${body.sha}` });
    }
    let data: Buffer;
    try {
      data = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
    } catch {
      return validationFailed(res);
    }
    const blobOid = addObject(repo, 'blob', data);
    map.set(cleanPath, { oid: blobOid, mode: '100644' });
    const commitOid = commitOnBranch(repo, branch, map, message, baseTip);
    const commit = commitJson(repo, commitOid);
    return sendJson(res, existing ? 200 : 201, {
      content: {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: cleanPath.split('/').pop(),
        path: cleanPath,
        sha: blobOid,
        url: `https://forge.local/api/v3/repos/${fullName}/contents/${cleanPath}`,
        git_url: `https://forge.local/api/v3/repos/${fullName}/git/blobs/${blobOid}`,
        html_url: `https://forge.local/${fullName}/blob/${branch}/${cleanPath}`,
        download_url: `https://forge.local/${fullName}/raw/${cleanPath}`,
        _links: {},
      },
      commit: commit?.commit
        ? { ...commit.commit, sha: commitOid, url: commit.url, html_url: commit.html_url, author: commit.commit.author, committer: commit.commit.committer }
        : { sha: commitOid },
    });
  }

  if (method === 'DELETE') {
    const body = jsonBody(r);
    if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
    const message = typeof body.message === 'string' ? body.message : '';
    const sha = typeof body.sha === 'string' ? body.sha : '';
    if (message === '' || sha === '') return validationFailed(res);
    const branch = typeof body.branch === 'string' && body.branch !== '' ? body.branch : repo.defaultBranch;
    const baseTip = repo.refs.get(`refs/heads/${branch}`) ?? null;
    if (!baseTip) return notFound(res);
    const map = commitMap(repo, baseTip);
    const existing = map.get(cleanPath);
    if (!existing) return notFound(res);
    if (existing.oid !== sha) {
      return sendJson(res, 409, { message: `${cleanPath} does not match ${sha}` });
    }
    map.delete(cleanPath);
    const commitOid = commitOnBranch(repo, branch, map, message, baseTip);
    return sendJson(res, 200, { content: null, commit: { sha: commitOid } });
  }

  return notFound(res);
}

// ---------------------------------------------------------------------------
// git data API (refs, blobs, trees, commits)
// ---------------------------------------------------------------------------

function refJson(repo: Repo, ref: string): Record<string, unknown> {
  const oid = repo.refs.get(ref) as string;
  const obj = repo.objects.get(oid);
  return {
    ref,
    node_id: Buffer.from(`Ref:${ref}`).toString('base64'),
    url: `https://forge.local/api/v3/repos/${viewerLogin()}/${repo.name}/git/${ref}`,
    object: { type: obj?.type ?? 'commit', sha: oid, url: `https://forge.local/api/v3/repos/${viewerLogin()}/${repo.name}/git/commits/${oid}` },
  };
}

function handleGitData(r: RestRequest, repo: Repo, rest: string[]): void {
  const { req, res } = r;
  const method = req.method ?? 'GET';
  const kind = rest[0];

  if (kind === 'refs') {
    if (rest.length === 1) {
      if (method === 'POST') {
        const body = jsonBody(r);
        if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
        const ref = typeof body.ref === 'string' ? body.ref : '';
        const sha = typeof body.sha === 'string' ? body.sha : '';
        if (!ref.startsWith('refs/') || !repo.objects.has(sha)) return validationFailed(res);
        if (repo.refs.has(ref)) return sendJson(res, 422, { message: 'Reference already exists' });
        repo.refs.set(ref, sha);
        repo.updatedAt = nowIso();
        return sendJson(res, 201, refJson(repo, ref));
      }
      if (method === 'GET') {
        const all = [...repo.refs.keys()].sort().map((ref) => refJson(repo, ref));
        return paginate(req, res, r.rawPath, r.query, all);
      }
      return notFound(res);
    }
    const ref = `refs/${rest.slice(1).join('/')}`;
    if (method === 'GET') {
      if (!repo.refs.has(ref)) return notFound(res);
      return sendJson(res, 200, refJson(repo, ref));
    }
    if (method === 'DELETE') {
      if (!repo.refs.has(ref)) return notFound(res);
      repo.refs.delete(ref);
      res.writeHead(204, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    return notFound(res);
  }

  if (kind === 'blobs' && rest.length === 2 && method === 'GET') {
    const obj = repo.objects.get(rest[1]);
    if (!obj || obj.type !== 'blob') return notFound(res);
    return sendJson(res, 200, {
      content: obj.data.toString('base64'),
      encoding: 'base64',
      url: `https://forge.local/api/v3/repos/${viewerLogin()}/${repo.name}/git/blobs/${rest[1]}`,
      sha: rest[1],
      size: obj.data.length,
    });
  }

  if (kind === 'trees' && rest.length === 2 && method === 'GET') {
    const obj = repo.objects.get(rest[1]);
    if (!obj || obj.type !== 'tree') return notFound(res);
    const tree = parseTree(obj.data).map((entry) => ({
      path: entry.name,
      mode: entry.mode.padStart(6, '0'),
      type: entry.mode === '40000' ? 'tree' : 'blob',
      sha: entry.oid,
      size: entry.mode === '40000' ? undefined : (repo.objects.get(entry.oid)?.data.length ?? 0),
      url: `https://forge.local/api/v3/repos/${viewerLogin()}/${repo.name}/git/${entry.mode === '40000' ? 'trees' : 'blobs'}/${entry.oid}`,
    }));
    return sendJson(res, 200, { sha: rest[1], url: `https://forge.local/api/v3/repos/${viewerLogin()}/${repo.name}/git/trees/${rest[1]}`, tree, truncated: false });
  }

  if (kind === 'commits' && rest.length === 2 && method === 'GET') {
    const commit = commitJson(repo, rest[1]);
    if (!commit) return notFound(res);
    return sendJson(res, 200, {
      sha: commit.sha,
      author: commit.commit ? (commit.commit as Record<string, unknown>).author : null,
      committer: commit.commit ? (commit.commit as Record<string, unknown>).committer : null,
      message: commit.commit ? (commit.commit as Record<string, unknown>).message : '',
      tree: commit.commit ? (commit.commit as Record<string, unknown>).tree : null,
      url: commit.url,
      parents: commit.parents,
    });
  }

  return notFound(res);
}

// ---------------------------------------------------------------------------
// issues and pulls
// ---------------------------------------------------------------------------

function handleIssues(r: RestRequest, repo: Repo, rest: string[]): void {
  const { req, res } = r;
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') {
      const stateParam = r.query.get('state') ?? 'open';
      const direction = r.query.get('direction') ?? 'desc';
      let issues = [...repo.issues.values()];
      if (stateParam === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (stateParam === 'closed') issues = issues.filter((i) => i.state === 'closed');
      issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      return paginate(req, res, r.rawPath, r.query, issues.map((i) => issueJson(repo, i)));
    }
    if (method === 'POST') {
      const body = jsonBody(r);
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const title = typeof body.title === 'string' ? body.title : '';
      if (title === '') return validationFailed(res);
      const labelNames: string[] = [];
      if (Array.isArray(body.labels)) {
        for (const entry of body.labels) {
          const name = typeof entry === 'string' ? entry : (entry as { name?: unknown })?.name;
          if (typeof name !== 'string' || !repo.labels.has(name)) return validationFailed(res);
          labelNames.push(name);
        }
      }
      const issue = newIssue(repo, title, typeof body.body === 'string' ? body.body : null, labelNames);
      return sendJson(res, 201, issueJson(repo, issue));
    }
    return notFound(res);
  }

  const number = Number.parseInt(rest[0], 10);
  const issue = Number.isFinite(number) ? repo.issues.get(number) : undefined;
  if (!issue) return notFound(res);

  if (rest.length === 1) {
    if (method === 'GET') return sendJson(res, 200, issueJson(repo, issue));
    if (method === 'PATCH') {
      const body = jsonBody(r);
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      if (typeof body.title === 'string') issue.title = body.title;
      if (typeof body.body === 'string' || body.body === null) issue.body = body.body as string | null;
      if (body.state === 'open' || body.state === 'closed') {
        issue.state = body.state;
        issue.closedAt = body.state === 'closed' ? nowIso() : null;
      }
      issue.updatedAt = nowIso();
      return sendJson(res, 200, issueJson(repo, issue));
    }
    return notFound(res);
  }

  if (rest[1] === 'comments' && rest.length === 2) {
    if (method === 'GET') {
      return paginate(req, res, r.rawPath, r.query, issue.comments.map((c) => commentJson(repo, issue, c)));
    }
    if (method === 'POST') {
      const body = jsonBody(r);
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const text = typeof body.body === 'string' ? body.body : '';
      if (text === '') return validationFailed(res);
      const comment = addComment(repo, issue, text);
      issue.updatedAt = nowIso();
      return sendJson(res, 201, commentJson(repo, issue, comment));
    }
    return notFound(res);
  }

  return notFound(res);
}

function handlePulls(r: RestRequest, repo: Repo, rest: string[]): void {
  const { req, res } = r;
  const method = req.method ?? 'GET';

  if (rest.length === 0) {
    if (method === 'GET') {
      const stateParam = r.query.get('state') ?? 'open';
      const direction = r.query.get('direction') ?? 'desc';
      let pulls = [...repo.pulls.values()];
      if (stateParam === 'open') pulls = pulls.filter((p) => p.state === 'open');
      else if (stateParam === 'closed') pulls = pulls.filter((p) => p.state === 'closed');
      pulls.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
      return paginate(req, res, r.rawPath, r.query, pulls.map((p) => pullJson(repo, p)));
    }
    if (method === 'POST') {
      const body = jsonBody(r);
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      const title = typeof body.title === 'string' ? body.title : '';
      const stripOwner = (value: unknown): string => {
        if (typeof value !== 'string') return '';
        const idx = value.indexOf(':');
        return idx >= 0 ? value.slice(idx + 1) : value;
      };
      const head = stripOwner(body.head);
      const base = stripOwner(body.base);
      if (title === '' || head === '' || base === '') return validationFailed(res);
      if (head === base) return validationFailed(res);
      if (!branchTip(repo, head) || !branchTip(repo, base)) return validationFailed(res);
      const duplicate = [...repo.pulls.values()].some(
        (p) => p.state === 'open' && p.head === head && p.base === base,
      );
      if (duplicate) return validationFailed(res);
      const pull = newPull(repo, title, typeof body.body === 'string' ? body.body : null, head, base);
      return sendJson(res, 201, pullJson(repo, pull));
    }
    return notFound(res);
  }

  const number = Number.parseInt(rest[0], 10);
  const pull = Number.isFinite(number) ? repo.pulls.get(number) : undefined;
  if (!pull) return notFound(res);

  if (rest.length === 1) {
    if (method === 'GET') return sendJson(res, 200, pullJson(repo, pull));
    if (method === 'PATCH') {
      const body = jsonBody(r);
      if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
      if (typeof body.title === 'string') pull.title = body.title;
      if (typeof body.body === 'string' || body.body === null) pull.body = body.body as string | null;
      if (body.state === 'open' || body.state === 'closed') {
        pull.state = body.state;
        pull.closedAt = body.state === 'closed' ? nowIso() : null;
      }
      pull.updatedAt = nowIso();
      return sendJson(res, 200, pullJson(repo, pull));
    }
    return notFound(res);
  }

  if (rest[1] === 'files' && rest.length === 2 && method === 'GET') {
    const files = pullDiffFiles(repo, pull).map((file) => ({
      sha: file.headOid ?? file.baseOid ?? ZERO_OID,
      filename: file.path,
      status: file.status,
      additions: file.additions,
      deletions: file.deletions,
      changes: file.additions + file.deletions,
      blob_url: `https://forge.local/api/v3/repos/${viewerLogin()}/${repo.name}/git/blobs/${file.headOid ?? file.baseOid ?? ZERO_OID}`,
      raw_url: `https://forge.local/${viewerLogin()}/${repo.name}/raw/${pull.head}/${file.path}`,
      contents_url: `https://forge.local/api/v3/repos/${viewerLogin()}/${repo.name}/contents/${file.path}?ref=${pull.head}`,
    }));
    return paginate(req, res, r.rawPath, r.query, files);
  }

  if (rest[1] === 'merge' && rest.length === 2 && method === 'PUT') {
    const body = jsonBody(r);
    if (body === null) return sendJson(res, 400, { message: 'Problems parsing JSON' });
    if (pull.state !== 'open' || pull.merged) {
      return sendJson(res, 405, { message: 'Pull Request is not mergeable' });
    }
    const mergeMethod = typeof body.merge_method === 'string' ? body.merge_method : 'merge';
    const outcome = mergePull(repo, pull, mergeMethod);
    if (!outcome.ok) {
      if (outcome.reason === 'missing') return sendJson(res, 404, { message: 'Not Found' });
      return sendJson(res, 405, { message: 'Pull Request is not mergeable' });
    }
    return sendJson(res, 200, { sha: outcome.sha, merged: true, message: 'Pull Request successfully merged' });
  }

  return notFound(res);
}

// ---------------------------------------------------------------------------
// git smart HTTP routing
// ---------------------------------------------------------------------------

function handleGitHttp(
  req: IncomingMessage,
  res: ServerResponse,
  segments: string[],
  query: URLSearchParams,
  body: Buffer,
): boolean {
  if (segments.length < 2) return false;
  const repoSegment = segments[1];
  if (!repoSegment.endsWith('.git')) return false;
  const owner = segments[0];
  const name = repoSegment.slice(0, -'.git'.length);
  const rest = segments.slice(2);
  const method = req.method ?? 'GET';

  if (rest.length === 2 && rest[0] === 'info' && rest[1] === 'refs' && method === 'GET') {
    const service = query.get('service');
    if (service !== 'git-upload-pack' && service !== 'git-receive-pack') {
      sendJson(res, 400, { message: 'Bad Request' });
      return true;
    }
    const repo = lookupRepo(owner, name);
    if (!repo) {
      notFound(res);
      return true;
    }
    if (service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '').includes('version=2')) {
      sendRaw(res, 200, v2Advertisement(), 'application/x-git-upload-pack-advertisement');
    } else {
      sendRaw(res, 200, v0Advertisement(repo, service), `application/x-${service}-advertisement`);
    }
    return true;
  }

  if (rest.length === 1 && rest[0] === 'git-upload-pack' && method === 'POST') {
    const repo = lookupRepo(owner, name);
    if (!repo) {
      notFound(res);
      return true;
    }
    try {
      const protocolV2 = (req.headers['git-protocol'] ?? '').includes('version=2');
      const outcome = uploadPack(repo, body, protocolV2);
      sendRaw(res, outcome.status, outcome.body, 'application/x-git-upload-pack-result');
    } catch (error) {
      console.error('upload-pack failed:', error);
      sendJson(res, 400, { message: 'Bad Request' });
    }
    return true;
  }

  if (rest.length === 1 && rest[0] === 'git-receive-pack' && method === 'POST') {
    const repo = lookupRepo(owner, name);
    if (!repo) {
      notFound(res);
      return true;
    }
    try {
      const outcome = receivePack(repo, body);
      sendRaw(res, outcome.status, outcome.body, 'application/x-git-receive-pack-result');
    } catch (error) {
      console.error('receive-pack failed:', error);
      sendJson(res, 400, { message: 'Bad Request' });
    }
    return true;
  }

  return false;
}

// ---------------------------------------------------------------------------
// GraphQL endpoint (single documents and batched arrays)
// ---------------------------------------------------------------------------

function handleGraphQL(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return;
  }
  if (!authed(req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, { errors: [{ message: 'Problems parsing JSON' }] });
    return;
  }
  if (Array.isArray(parsed)) {
    const results = parsed.map((entry) => {
      const doc = (entry ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
      return executeGraphQL(
        typeof doc.query === 'string' ? doc.query : '',
        typeof doc.variables === 'object' && doc.variables !== null ? (doc.variables as Record<string, unknown>) : {},
        typeof doc.operationName === 'string' ? doc.operationName : undefined,
      );
    });
    sendJson(res, 200, results);
    return;
  }
  const doc = (parsed ?? {}) as { query?: unknown; variables?: unknown; operationName?: unknown };
  const result = executeGraphQL(
    typeof doc.query === 'string' ? doc.query : '',
    typeof doc.variables === 'object' && doc.variables !== null ? (doc.variables as Record<string, unknown>) : {},
    typeof doc.operationName === 'string' ? doc.operationName : undefined,
  );
  sendJson(res, 200, result);
}

// ---------------------------------------------------------------------------
// MCP endpoint (JSON-RPC 2.0 over POST /mcp)
// ---------------------------------------------------------------------------

const MCP_TOOLS: Array<Record<string, unknown>> = [
  {
    name: 'create_repo',
    description: 'Create a new repository',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'Repository name' },
        description: { type: 'string', description: 'Repository description' },
        private: { type: 'boolean', description: 'Whether the repository is private' },
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        body: { type: 'string' },
      },
      required: ['owner', 'repo', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        state: { type: 'string', enum: ['open', 'closed', 'all'] },
      },
      required: ['owner', 'repo'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        title: { type: 'string' },
        head: { type: 'string' },
        base: { type: 'string' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
      additionalProperties: false,
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string' },
        repo: { type: 'string' },
        pull_number: { type: 'number' },
      },
      required: ['owner', 'repo', 'pull_number'],
      additionalProperties: false,
    },
  },
];

const MCP_DISCOVER_RESULT = {
  protocolVersion: '2026-07-28',
  supportedVersions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
  capabilities: { tools: {} },
  serverInfo: { name: 'forge-mcp', version: '1.0.0' },
};

const MCP_ERRORS = {
  parse: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internal: -32603,
} as const;

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id, result };
}

function toolText(structured: unknown): Array<Record<string, unknown>> {
  return [{ type: 'text', text: JSON.stringify(structured) }];
}

function toolErrorResult(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

function callTool(name: string, args: Record<string, unknown>): Record<string, unknown> | null {
  const requiredFor = (tool: (typeof MCP_TOOLS)[number]): string[] =>
    ((tool.inputSchema as { required?: string[] }).required ?? []);
  const tool = MCP_TOOLS.find((t) => t.name === name);
  if (!tool) return null;
  for (const key of requiredFor(tool)) {
    if (args[key] === undefined || args[key] === null || args[key] === '') {
      throw Object.assign(new Error(`Missing required argument: ${key}`), { rpcCode: MCP_ERRORS.invalidParams });
    }
  }
  const str = (key: string): string => String(args[key]);
  switch (name) {
    case 'create_repo': {
      const repoName = str('name');
      if (repoByName(repoName)) return toolErrorResult(`Repository ${repoName} already exists`);
      const repo = createRepo(
        repoName,
        typeof args.description === 'string' ? args.description : null,
        args.private === true,
      );
      if (!repo) return toolErrorResult('Invalid repository name');
      const json = repoJson(repo);
      return { content: toolText(json), structuredContent: json };
    }
    case 'get_repo': {
      const repo = lookupRepo(str('owner'), str('repo'));
      if (!repo) return toolErrorResult('Repository not found');
      const json = repoJson(repo);
      return { content: toolText(json), structuredContent: json };
    }
    case 'create_issue': {
      const repo = lookupRepo(str('owner'), str('repo'));
      if (!repo) return toolErrorResult('Repository not found');
      const issue = newIssue(repo, str('title'), typeof args.body === 'string' ? args.body : null, []);
      const json = issueJson(repo, issue);
      return { content: toolText(json), structuredContent: json };
    }
    case 'list_issues': {
      const repo = lookupRepo(str('owner'), str('repo'));
      if (!repo) return toolErrorResult('Repository not found');
      const stateParam = typeof args.state === 'string' ? args.state : 'open';
      let issues = [...repo.issues.values()];
      if (stateParam === 'open') issues = issues.filter((i) => i.state === 'open');
      else if (stateParam === 'closed') issues = issues.filter((i) => i.state === 'closed');
      issues.sort((a, b) => b.seq - a.seq);
      const list = issues.map((i) => issueJson(repo, i));
      const payload = { issues: list, count: list.length };
      return { content: toolText(payload), structuredContent: payload };
    }
    case 'create_pull_request': {
      const repo = lookupRepo(str('owner'), str('repo'));
      if (!repo) return toolErrorResult('Repository not found');
      const head = str('head');
      const base = str('base');
      if (!branchTip(repo, head) || !branchTip(repo, base)) {
        return toolErrorResult('Head or base branch not found');
      }
      const pull = newPull(repo, str('title'), typeof args.body === 'string' ? args.body : null, head, base);
      const json = pullJson(repo, pull);
      return { content: toolText(json), structuredContent: json };
    }
    case 'merge_pull_request': {
      const repo = lookupRepo(str('owner'), str('repo'));
      if (!repo) return toolErrorResult('Repository not found');
      const pullNumber = typeof args.pull_number === 'number' ? args.pull_number : Number(args.pull_number);
      const pull = repo.pulls.get(pullNumber);
      if (!pull) return toolErrorResult('Pull request not found');
      const outcome = mergePull(repo, pull, 'merge');
      if (!outcome.ok) return toolErrorResult(outcome.reason === 'missing' ? 'Pull request not found' : 'Pull Request is not mergeable');
      const payload = { merged: true, sha: outcome.sha, pull_number: pull.number };
      return { content: toolText(payload), structuredContent: payload };
    }
    default:
      return null;
  }
}

function handleMcpMessage(message: Record<string, unknown>): Record<string, unknown> | null {
  const method = typeof message.method === 'string' ? message.method : '';
  const id = 'id' in message ? message.id : undefined;
  const isNotification = id === undefined;
  switch (method) {
    case 'server/discover':
      return rpcResult(id, MCP_DISCOVER_RESULT);
    case 'initialize': {
      const params = (message.params ?? {}) as { protocolVersion?: unknown };
      const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : '2025-06-18';
      const supported = MCP_DISCOVER_RESULT.supportedVersions.includes(requested)
        ? requested
        : MCP_DISCOVER_RESULT.supportedVersions[1];
      return rpcResult(id, {
        protocolVersion: supported,
        capabilities: { tools: {} },
        serverInfo: { name: 'forge-mcp', version: '1.0.0' },
      });
    }
    case 'ping':
      return rpcResult(id, {});
    case 'tools/list':
      return rpcResult(id, { tools: MCP_TOOLS });
    case 'tools/call': {
      const params = (message.params ?? {}) as { name?: unknown; arguments?: unknown };
      const toolName = typeof params.name === 'string' ? params.name : '';
      const args = (typeof params.arguments === 'object' && params.arguments !== null
        ? params.arguments
        : {}) as Record<string, unknown>;
      try {
        const result = callTool(toolName, args);
        if (result === null) return rpcError(id, MCP_ERRORS.invalidParams, `Unknown tool: ${toolName}`);
        return rpcResult(id, result);
      } catch (error) {
        const code = (error as { rpcCode?: number }).rpcCode ?? MCP_ERRORS.internal;
        return rpcError(id, code, error instanceof Error ? error.message : 'Internal error');
      }
    }
    default:
      if (isNotification) return null;
      return rpcError(id, MCP_ERRORS.methodNotFound, `Method not found: ${method}`);
  }
}

function handleMcp(req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (!authed(req)) {
    sendJson(res, 401, rpcError(null, MCP_ERRORS.invalidRequest, 'Unauthorized'));
    return;
  }
  if ((req.method ?? 'GET') !== 'POST') {
    sendJson(res, 405, rpcError(null, MCP_ERRORS.invalidRequest, 'Method Not Allowed'));
    return;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString('utf8'));
  } catch {
    sendJson(res, 400, rpcError(null, MCP_ERRORS.parse, 'Parse error'));
    return;
  }
  if (Array.isArray(parsed)) {
    const responses: Array<Record<string, unknown>> = [];
    for (const entry of parsed) {
      if (typeof entry !== 'object' || entry === null) continue;
      const response = handleMcpMessage(entry as Record<string, unknown>);
      if (response) responses.push(response);
    }
    if (responses.length === 0) {
      res.writeHead(202, { 'x-github-request-id': requestId() });
      res.end();
      return;
    }
    sendJson(res, 200, responses);
    return;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    sendJson(res, 400, rpcError(null, MCP_ERRORS.parse, 'Parse error'));
    return;
  }
  const response = handleMcpMessage(parsed as Record<string, unknown>);
  if (response === null) {
    res.writeHead(202, { 'x-github-request-id': requestId() });
    res.end();
    return;
  }
  sendJson(res, 200, response);
}

// ---------------------------------------------------------------------------
// server assembly
// ---------------------------------------------------------------------------

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > 512 * 1024 * 1024) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function createApp(): Server {
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? '/', 'http://forge.local');
        const rawPath = url.pathname;
        const segments = rawPath.split('/').filter((s) => s !== '').map(decodeSegment);
        const body = await readBody(req);

        if (rawPath === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'v3') {
          handleRest({
            req,
            res,
            segments: segments.slice(2),
            query: url.searchParams,
            rawPath,
            body,
          });
          return;
        }

        if (segments[0] === 'api' && segments[1] === 'graphql') {
          handleGraphQL(req, res, body);
          return;
        }

        if (segments[0] === 'mcp' && segments.length === 1) {
          handleMcp(req, res, body);
          return;
        }

        if (handleGitHttp(req, res, segments, url.searchParams, body)) return;

        notFound(res);
      } catch {
        if (!res.headersSent) {
          try {
            sendJson(res, 500, { message: 'Internal Server Error' });
          } catch { /* socket already gone */ }
        } else {
          try {
            res.end();
          } catch { /* socket already gone */ }
        }
      }
    })();
  });
}
