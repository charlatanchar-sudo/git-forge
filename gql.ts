// A compact GraphQL executor for the documents gh and github-mcp-server send: operations with
// variables, aliases, inline fragments, batching, Relay global ids, cursor connections and the
// __type introspection probes. Not a general GraphQL server — a faithful subset over the forge's
// own store, with GitHub's error shapes (HTTP 200 + an errors array naming the bad field).

import {
  lookupRepo,
  repoByName,
  state,
  viewerLogin,
  type IssueRec,
  type PullRec,
  type Repo,
} from './core.ts';
import { addComment, branchTip, mergePull, newIssue, newPull, pullDiffFiles, pullMergeable } from './domain.ts';

// ---------------------------------------------------------------------------
// global ids
// ---------------------------------------------------------------------------

export function globalId(type: string, key: string): string {
  return Buffer.from(`${type}:${key}`, 'utf8').toString('base64');
}

function decodeGlobalId(id: string): { type: string; key: string } | null {
  try {
    const text = Buffer.from(id, 'base64').toString('utf8');
    const colon = text.indexOf(':');
    if (colon < 0) return null;
    return { type: text.slice(0, colon), key: text.slice(colon + 1) };
  } catch {
    return null;
  }
}

function repoGlobalId(repo: Repo): string {
  return globalId('Repository', String(repo.id));
}

function issueGlobalId(repo: Repo, issue: IssueRec): string {
  return globalId('Issue', `${repo.id}:${issue.number}`);
}

function pullGlobalId(repo: Repo, pull: PullRec): string {
  return globalId('PullRequest', `${repo.id}:${pull.number}`);
}

function findRepoByGlobalId(id: string): Repo | null {
  const decoded = decodeGlobalId(id);
  if (!decoded || decoded.type !== 'Repository') return null;
  for (const repo of state.repos.values()) if (repo.id === Number(decoded.key)) return repo;
  return null;
}

// ---------------------------------------------------------------------------
// tokenizer + parser
// ---------------------------------------------------------------------------

interface Token {
  kind: 'name' | 'string' | 'number' | 'punct' | 'spread' | 'eof';
  value: string;
}

function tokenize(source: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < source.length) {
    const ch = source[i];
    if (ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',') {
      i += 1;
      continue;
    }
    if (ch === '#') {
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (source.startsWith('...', i)) {
      tokens.push({ kind: 'spread', value: '...' });
      i += 3;
      continue;
    }
    if ('{}()[]:@$!='.includes(ch)) {
      tokens.push({ kind: 'punct', value: ch });
      i += 1;
      continue;
    }
    if (ch === '"') {
      if (source.startsWith('"""', i)) {
        const end = source.indexOf('"""', i + 3);
        tokens.push({ kind: 'string', value: source.slice(i + 3, end === -1 ? source.length : end) });
        i = end === -1 ? source.length : end + 3;
        continue;
      }
      let j = i + 1;
      let value = '';
      while (j < source.length && source[j] !== '"') {
        if (source[j] === '\\' && j + 1 < source.length) {
          const esc = source[j + 1];
          value += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          value += source[j];
          j += 1;
        }
      }
      tokens.push({ kind: 'string', value });
      i = j + 1;
      continue;
    }
    if (/[0-9-]/.test(ch)) {
      let j = i;
      while (j < source.length && /[0-9.eE+-]/.test(source[j])) j += 1;
      tokens.push({ kind: 'number', value: source.slice(i, j) });
      i = j;
      continue;
    }
    if (/[_A-Za-z]/.test(ch)) {
      let j = i;
      while (j < source.length && /[_0-9A-Za-z]/.test(source[j])) j += 1;
      tokens.push({ kind: 'name', value: source.slice(i, j) });
      i = j;
      continue;
    }
    i += 1;
  }
  tokens.push({ kind: 'eof', value: '' });
  return tokens;
}

type Value =
  | { kind: 'var'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'number'; value: number }
  | { kind: 'bool'; value: boolean }
  | { kind: 'enum'; value: string }
  | { kind: 'null' }
  | { kind: 'list'; items: Value[] }
  | { kind: 'object'; fields: Map<string, Value> };

interface FieldNode {
  alias: string | null;
  name: string;
  args: Map<string, Value>;
  selection: FieldNode[] | null;
}

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  selection: FieldNode[];
}

class Parser {
  private tokens: Token[];
  private pos = 0;
  readonly fragments = new Map<string, { typeCondition: string; selection: FieldNode[] }>();

  constructor(source: string) {
    this.tokens = tokenize(source);
  }

  private peek(): Token {
    return this.tokens[this.pos];
  }

  private next(): Token {
    return this.tokens[this.pos++];
  }

  private expect(value: string): void {
    const token = this.next();
    if (token.value !== value) throw new Error(`expected ${value}, found ${token.value}`);
  }

  parseDocument(): Operation[] {
    const operations: Operation[] = [];
    while (this.peek().kind !== 'eof') {
      const token = this.peek();
      if (token.value === '{') {
        operations.push({ type: 'query', name: null, selection: this.parseSelectionSet() });
      } else if (token.kind === 'name' && (token.value === 'query' || token.value === 'mutation' || token.value === 'subscription')) {
        this.next();
        let name: string | null = null;
        if (this.peek().kind === 'name') name = this.next().value;
        if (this.peek().value === '(') this.skipBalanced();
        this.skipDirectives();
        operations.push({
          type: token.value === 'mutation' ? 'mutation' : 'query',
          name,
          selection: this.parseSelectionSet(),
        });
      } else if (token.kind === 'name' && token.value === 'fragment') {
        this.next();
        const fragName = this.next().value;
        this.next(); // 'on'
        const typeCondition = this.next().value;
        this.skipDirectives();
        this.fragments.set(fragName, { typeCondition, selection: this.parseSelectionSet() });
      } else {
        this.next();
      }
    }
    return operations;
  }

  private skipBalanced(): void {
    let depth = 0;
    do {
      const token = this.next();
      if (token.value === '(' || token.value === '[' || token.value === '{') depth += 1;
      else if (token.value === ')' || token.value === ']' || token.value === '}') depth -= 1;
    } while (depth > 0 && this.peek().kind !== 'eof');
  }

  private skipDirectives(): void {
    while (this.peek().value === '@') {
      this.next();
      this.next();
      if (this.peek().value === '(') this.skipBalanced();
    }
  }

  parseSelectionSet(): FieldNode[] {
    this.expect('{');
    const fields: FieldNode[] = [];
    while (this.peek().value !== '}') {
      if (this.peek().kind === 'spread') {
        this.next();
        if (this.peek().kind === 'name' && this.peek().value === 'on') {
          this.next();
          const typeCondition = this.next().value;
          this.skipDirectives();
          const inner = this.parseSelectionSet();
          fields.push({ alias: null, name: `__inline:${typeCondition}`, args: new Map(), selection: inner });
        } else {
          const fragName = this.next().value;
          this.skipDirectives();
          fields.push({ alias: null, name: `__fragment:${fragName}`, args: new Map(), selection: null });
        }
        continue;
      }
      let name = this.next().value;
      let alias: string | null = null;
      if (this.peek().value === ':') {
        this.next();
        alias = name;
        name = this.next().value;
      }
      const args = new Map<string, Value>();
      if (this.peek().value === '(') {
        this.next();
        while (this.peek().value !== ')') {
          const argName = this.next().value;
          this.expect(':');
          args.set(argName, this.parseValue());
        }
        this.expect(')');
      }
      this.skipDirectives();
      let selection: FieldNode[] | null = null;
      if (this.peek().value === '{') selection = this.parseSelectionSet();
      fields.push({ alias, name, args, selection });
    }
    this.expect('}');
    return fields;
  }

  private parseValue(): Value {
    const token = this.next();
    if (token.value === '$') return { kind: 'var', name: this.next().value };
    if (token.kind === 'string') return { kind: 'string', value: token.value };
    if (token.kind === 'number') return { kind: 'number', value: Number(token.value) };
    if (token.value === '[') {
      const items: Value[] = [];
      while (this.peek().value !== ']') items.push(this.parseValue());
      this.expect(']');
      return { kind: 'list', items };
    }
    if (token.value === '{') {
      const fields = new Map<string, Value>();
      while (this.peek().value !== '}') {
        const key = this.next().value;
        this.expect(':');
        fields.set(key, this.parseValue());
      }
      this.expect('}');
      return { kind: 'object', fields };
    }
    if (token.kind === 'name') {
      if (token.value === 'true') return { kind: 'bool', value: true };
      if (token.value === 'false') return { kind: 'bool', value: false };
      if (token.value === 'null') return { kind: 'null' };
      return { kind: 'enum', value: token.value };
    }
    return { kind: 'null' };
  }
}

function resolveValue(value: Value, vars: Record<string, unknown>): unknown {
  switch (value.kind) {
    case 'var':
      return vars[value.name];
    case 'string':
    case 'number':
    case 'bool':
    case 'enum':
      return value.value;
    case 'null':
      return null;
    case 'list':
      return value.items.map((item) => resolveValue(item, vars));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const [key, inner] of value.fields) out[key] = resolveValue(inner, vars);
      return out;
    }
  }
}

// ---------------------------------------------------------------------------
// schema surface (introspection + unknown-field detection)
// ---------------------------------------------------------------------------

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', 'nodes', 'rateLimit', '__type', '__schema', 'search', 'user', 'organization'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment', 'reopenIssue', 'updateIssue', 'createRepository'],
  User: ['login', 'id', 'name', 'email', 'url', 'avatarUrl', 'databaseId', 'isViewer', 'createdAt', 'updatedAt'],
  Repository: [
    'id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission',
    'hasIssuesEnabled', 'hasProjectsEnabled', 'hasWikiEnabled', 'isPrivate', 'isFork', 'isArchived',
    'description', 'url', 'sshUrl', 'homepageUrl', 'createdAt', 'updatedAt', 'pushedAt', 'issue',
    'issues', 'pullRequest', 'pullRequests', 'labels', 'stargazerCount', 'forkCount', 'watchers',
    'primaryLanguage', 'licenseInfo', 'parent', 'templateRepository', 'visibility', 'isTemplate',
  ],
  Issue: [
    'id', 'databaseId', 'number', 'title', 'state', 'body', 'bodyText', 'url', 'author', 'editor',
    'labels', 'comments', 'assignees', 'milestone', 'repository', 'createdAt', 'updatedAt',
    'closedAt', 'closed', 'locked', 'viewerDidAuthor', 'reactionGroups', 'participants',
  ],
  PullRequest: [
    'id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergedAt', 'mergeable',
    'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'mergeCommit', 'potentialMergeCommit',
    'files', 'commits', 'author', 'url', 'repository', 'createdAt', 'updatedAt', 'closedAt',
    'closed', 'locked', 'isDraft', 'additions', 'deletions', 'changedFiles', 'labels', 'comments',
    'headRepository', 'baseRepository', 'viewerDidAuthor',
  ],
  IssueComment: ['id', 'databaseId', 'body', 'bodyText', 'author', 'url', 'createdAt', 'updatedAt', 'issue', 'pullRequest'],
  Ref: ['name', 'prefix', 'target', 'repository', 'associatedPullRequests'],
  Label: ['id', 'name', 'color', 'description', 'url'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestFileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  PullRequestFile: ['path', 'additions', 'deletions', 'changeType', 'viewerViewedState'],
  Commit: ['id', 'oid', 'message', 'messageHeadline', 'author', 'committer', 'committedDate', 'tree'],
  GitActor: ['name', 'email', 'date', 'avatarUrl', 'user'],
  CreateIssuePayload: ['issue', 'clientMutationId'],
  CloseIssuePayload: ['issue', 'clientMutationId'],
  CreatePullRequestPayload: ['pullRequest', 'clientMutationId'],
  MergePullRequestPayload: ['pullRequest', 'clientMutationId'],
  AddCommentPayload: ['commentEdge', 'subject', 'clientMutationId'],
  IssueCommentEdge: ['node', 'cursor'],
  RateLimit: ['limit', 'cost', 'remaining', 'resetAt', 'used', 'nodeCount'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'possibleTypes', 'inputFields', 'interfaces', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __Schema: ['types', 'queryType', 'mutationType', 'subscriptionType', 'directives'],
};

const SEARCH_TYPE_VALUES = ['ISSUE', 'USER', 'REPOSITORY', 'DISCUSSION', 'PULL_REQUEST'];

// ---------------------------------------------------------------------------
// execution
// ---------------------------------------------------------------------------

interface Ctx {
  vars: Record<string, unknown>;
  errors: Array<{ message: string }>;
  fragments: Map<string, { typeCondition: string; selection: FieldNode[] }>;
}

type Source =
  | { type: 'User' }
  | { type: 'Repository'; repo: Repo }
  | { type: 'Issue'; repo: Repo; issue: IssueRec }
  | { type: 'PullRequest'; repo: Repo; pull: PullRec }
  | { type: 'IssueComment'; repo: Repo; comment: IssueRec['comments'][number] }
  | { type: 'Ref'; name: string }
  | { type: 'Label'; name: string; color: string }
  | { type: '__Type'; name: string }
  | { type: 'Raw'; value: unknown }
  | null;

function cursorFor(number: number): string {
  return Buffer.from(`cursor:${number}`, 'utf8').toString('base64');
}

function numberFromCursor(cursor: string): number | null {
  try {
    const text = Buffer.from(cursor, 'base64').toString('utf8');
    const match = /^cursor:(\d+)$/.exec(text);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

interface Connection<T> {
  items: T[];
  totalCount: number;
  hasNextPage: boolean;
  endCursor: string | null;
}

/** Slice a created-ordered list into a connection page, honouring first/after and direction. */
function paginate<T extends { number: number }>(
  items: T[],
  args: Map<string, Value>,
  ctx: Ctx,
  defaultDirection: 'asc' | 'desc',
): Connection<T> {
  let direction = defaultDirection;
  const orderBy = args.get('orderBy');
  if (orderBy) {
    const resolved = resolveValue(orderBy, ctx.vars) as { direction?: string } | null;
    if (resolved && typeof resolved.direction === 'string') {
      direction = resolved.direction.toUpperCase() === 'ASC' ? 'asc' : 'desc';
    }
  }
  const sorted = [...items].sort((a, b) => (direction === 'asc' ? a.number - b.number : b.number - a.number));
  let start = 0;
  const after = args.get('after');
  if (after) {
    const afterValue = resolveValue(after, ctx.vars);
    if (typeof afterValue === 'string' && afterValue !== '') {
      const number = numberFromCursor(afterValue);
      const index = number === null ? -1 : sorted.findIndex((item) => item.number === number);
      if (index >= 0) start = index + 1;
    }
  }
  const firstValue = args.get('first') ? resolveValue(args.get('first')!, ctx.vars) : undefined;
  const first = typeof firstValue === 'number' ? Math.max(0, Math.trunc(firstValue)) : sorted.length;
  const page = sorted.slice(start, start + first);
  return {
    items: page,
    totalCount: sorted.length,
    hasNextPage: start + page.length < sorted.length,
    endCursor: page.length ? cursorFor(page[page.length - 1].number) : null,
  };
}

function argString(args: Map<string, Value>, name: string, ctx: Ctx): string | null {
  const value = args.get(name);
  if (!value) return null;
  const resolved = resolveValue(value, ctx.vars);
  return typeof resolved === 'string' ? resolved : null;
}

function argInt(args: Map<string, Value>, name: string, ctx: Ctx): number | null {
  const value = args.get(name);
  if (!value) return null;
  const resolved = resolveValue(value, ctx.vars);
  return typeof resolved === 'number' ? Math.trunc(resolved) : null;
}

function argObject(args: Map<string, Value>, name: string, ctx: Ctx): Record<string, unknown> {
  const value = args.get(name);
  if (!value) return {};
  const resolved = resolveValue(value, ctx.vars);
  return typeof resolved === 'object' && resolved !== null ? (resolved as Record<string, unknown>) : {};
}

/** Resolve one field on a typed source. Returns the child source/scalar, or undefined for unknown. */
function resolveField(typeName: string, field: string, source: Source, args: Map<string, Value>, ctx: Ctx): unknown {
  const login = viewerLogin();
  switch (typeName) {
    case 'Query': {
      if (field === 'viewer') return { type: 'User' } satisfies Source;
      if (field === 'repository') {
        const owner = argString(args, 'owner', ctx);
        const name = argString(args, 'name', ctx);
        if (owner === null || name === null) return null;
        const repo = lookupRepo(owner, name);
        return repo ? ({ type: 'Repository', repo } satisfies Source) : null;
      }
      if (field === 'node') {
        const id = argString(args, 'id', ctx);
        if (id === null) return null;
        const decoded = decodeGlobalId(id);
        if (!decoded) return null;
        if (decoded.type === 'Repository') {
          const repo = findRepoByGlobalId(id);
          return repo ? ({ type: 'Repository', repo } satisfies Source) : null;
        }
        if (decoded.type === 'Issue' || decoded.type === 'PullRequest') {
          const [repoId, number] = decoded.key.split(':').map(Number);
          for (const repo of state.repos.values()) {
            if (repo.id !== repoId) continue;
            if (decoded.type === 'Issue') {
              const issue = repo.issues.get(number);
              return issue ? ({ type: 'Issue', repo, issue } satisfies Source) : null;
            }
            const pull = repo.pulls.get(number);
            return pull ? ({ type: 'PullRequest', repo, pull } satisfies Source) : null;
          }
          return null;
        }
        return null;
      }
      if (field === '__type') {
        const name = argString(args, 'name', ctx);
        return name !== null && (TYPE_FIELDS[name] || name === 'SearchType') ? ({ type: '__Type', name } satisfies Source) : null;
      }
      if (field === 'rateLimit') return { type: 'Raw', value: { limit: 5000, cost: 1, remaining: 4999, used: 1, nodeCount: 1, resetAt: new Date(Date.now() + 3600_000).toISOString() } } satisfies Source;
      if (field === 'user') return { type: 'User' } satisfies Source;
      return undefined;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const input = argObject(args, 'input', ctx);
        const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(input.repositoryId) : null;
        if (!repo) return null;
        const issue = newIssue(repo, String(input.title ?? ''), String(input.body ?? ''), []);
        return { type: 'Raw', value: { __payload: 'CreateIssuePayload', issue: { type: 'Issue', repo, issue } } } satisfies Source;
      }
      if (field === 'closeIssue') {
        const input = argObject(args, 'input', ctx);
        const decoded = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
        if (!decoded || decoded.type !== 'Issue') return null;
        const [repoId, number] = decoded.key.split(':').map(Number);
        for (const repo of state.repos.values()) {
          if (repo.id !== repoId) continue;
          const issue = repo.issues.get(number);
          if (!issue) return null;
          issue.state = 'closed';
          issue.closedAt = new Date().toISOString();
          issue.updatedAt = issue.closedAt;
          return { type: 'Raw', value: { __payload: 'CloseIssuePayload', issue: { type: 'Issue', repo, issue } } } satisfies Source;
        }
        return null;
      }
      if (field === 'createPullRequest') {
        const input = argObject(args, 'input', ctx);
        const repo = typeof input.repositoryId === 'string' ? findRepoByGlobalId(input.repositoryId) : null;
        if (!repo) return null;
        const head = String(input.headRefName ?? '');
        const base = String(input.baseRefName ?? '');
        if (!branchTip(repo, head) || !branchTip(repo, base)) return null;
        const existing = [...repo.pulls.values()].find((p) => p.head === head && p.base === base && p.state === 'open');
        const pull = existing ?? newPull(repo, String(input.title ?? ''), String(input.body ?? ''), head, base);
        return { type: 'Raw', value: { __payload: 'CreatePullRequestPayload', pullRequest: { type: 'PullRequest', repo, pull } } } satisfies Source;
      }
      if (field === 'mergePullRequest') {
        const input = argObject(args, 'input', ctx);
        const decoded = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
        if (!decoded || decoded.type !== 'PullRequest') return null;
        const [repoId, number] = decoded.key.split(':').map(Number);
        for (const repo of state.repos.values()) {
          if (repo.id !== repoId) continue;
          const pull = repo.pulls.get(number);
          if (!pull) return null;
          const method = String(input.mergeMethod ?? 'SQUASH').toLowerCase();
          mergePull(repo, pull, method === 'merge' ? 'merge' : 'squash');
          return { type: 'Raw', value: { __payload: 'MergePullRequestPayload', pullRequest: { type: 'PullRequest', repo, pull } } } satisfies Source;
        }
        return null;
      }
      if (field === 'addComment') {
        const input = argObject(args, 'input', ctx);
        const decoded = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
        if (!decoded || decoded.type !== 'Issue') return null;
        const [repoId, number] = decoded.key.split(':').map(Number);
        for (const repo of state.repos.values()) {
          if (repo.id !== repoId) continue;
          const issue = repo.issues.get(number);
          if (!issue) return null;
          const comment = addComment(repo, issue, String(input.body ?? ''));
          return {
            type: 'Raw',
            value: { __payload: 'AddCommentPayload', commentEdge: { node: { type: 'IssueComment', repo, comment } }, subject: { type: 'Issue', repo, issue } },
          } satisfies Source;
        }
        return null;
      }
      return undefined;
    }
    case 'User': {
      switch (field) {
        case 'login': return login;
        case 'id': return globalId('User', '1');
        case 'databaseId': return 1;
        case 'name': return login;
        case 'email': return `${login}@example.invalid`;
        case 'url': return `https://forge.local/${login}`;
        case 'avatarUrl': return 'https://forge.local/avatar.png';
        case 'isViewer': return true;
        case 'createdAt':
        case 'updatedAt': return new Date().toISOString();
        default: return undefined;
      }
    }
    case 'Repository': {
      const repo = (source as { repo: Repo }).repo;
      switch (field) {
        case 'id': return repoGlobalId(repo);
        case 'databaseId': return repo.id;
        case 'name': return repo.name;
        case 'nameWithOwner': return `${login}/${repo.name}`;
        case 'owner': return { type: 'User' } satisfies Source;
        case 'defaultBranchRef': {
          const ref = `refs/heads/${repo.defaultBranch}`;
          return repo.refs.has(ref) ? ({ type: 'Ref', name: repo.defaultBranch } satisfies Source) : null;
        }
        case 'viewerPermission': return 'ADMIN';
        case 'hasIssuesEnabled': return true;
        case 'hasProjectsEnabled': return true;
        case 'hasWikiEnabled': return true;
        case 'isPrivate': return repo.isPrivate;
        case 'isFork': return false;
        case 'isArchived': return false;
        case 'isTemplate': return false;
        case 'description': return repo.description;
        case 'url': return `https://forge.local/${login}/${repo.name}`;
        case 'sshUrl': return `git@forge.local:${login}/${repo.name}.git`;
        case 'homepageUrl': return null;
        case 'createdAt': return repo.createdAt;
        case 'updatedAt': return repo.updatedAt;
        case 'pushedAt': return repo.updatedAt;
        case 'stargazerCount': return 0;
        case 'forkCount': return 0;
        case 'primaryLanguage': return null;
        case 'licenseInfo': return null;
        case 'parent': return null;
        case 'templateRepository': return null;
        case 'visibility': return repo.isPrivate ? 'PRIVATE' : 'PUBLIC';
        case 'issue': {
          const number = argInt(args, 'number', ctx);
          const issue = number === null ? undefined : repo.issues.get(number);
          return issue ? ({ type: 'Issue', repo, issue } satisfies Source) : null;
        }
        case 'issues': {
          const statesValue = args.get('states') ? resolveValue(args.get('states')!, ctx.vars) : null;
          const states = Array.isArray(statesValue) ? statesValue.map(String) : null;
          let items = [...repo.issues.values()];
          if (states) items = items.filter((issue) => states.includes(issue.state.toUpperCase()));
          const page = paginate(items, args, ctx, 'desc');
          return {
            type: 'Raw',
            value: {
              __payload: 'IssueConnection',
              nodes: page.items.map((issue) => ({ type: 'Issue', repo, issue })),
              pageInfo: { hasNextPage: page.hasNextPage, hasPreviousPage: false, startCursor: page.items.length ? cursorFor(page.items[0].number) : null, endCursor: page.endCursor },
              totalCount: page.totalCount,
            },
          } satisfies Source;
        }
        case 'pullRequest': {
          const number = argInt(args, 'number', ctx);
          const pull = number === null ? undefined : repo.pulls.get(number);
          return pull ? ({ type: 'PullRequest', repo, pull } satisfies Source) : null;
        }
        case 'pullRequests': {
          const statesValue = args.get('states') ? resolveValue(args.get('states')!, ctx.vars) : null;
          const states = Array.isArray(statesValue) ? statesValue.map(String) : ['OPEN'];
          let items = [...repo.pulls.values()];
          items = items.filter((pull) => {
            const gqlState = pull.merged ? 'MERGED' : pull.state.toUpperCase();
            return states.includes(gqlState) || (gqlState === 'MERGED' && states.includes('CLOSED'));
          });
          const page = paginate(items, args, ctx, 'desc');
          return {
            type: 'Raw',
            value: {
              __payload: 'PullRequestConnection',
              nodes: page.items.map((pull) => ({ type: 'PullRequest', repo, pull })),
              pageInfo: { hasNextPage: page.hasNextPage, hasPreviousPage: false, startCursor: page.items.length ? cursorFor(page.items[0].number) : null, endCursor: page.endCursor },
              totalCount: page.totalCount,
            },
          } satisfies Source;
        }
        default: return undefined;
      }
    }
    case 'Issue': {
      const { repo, issue } = source as { repo: Repo; issue: IssueRec };
      switch (field) {
        case 'id': return issueGlobalId(repo, issue);
        case 'databaseId': return issue.id;
        case 'number': return issue.number;
        case 'title': return issue.title;
        case 'state': return issue.state.toUpperCase();
        case 'body':
        case 'bodyText': return issue.body;
        case 'url': return `https://forge.local/${login}/${repo.name}/issues/${issue.number}`;
        case 'author': return { type: 'User' } satisfies Source;
        case 'editor': return null;
        case 'labels': {
          return {
            type: 'Raw',
            value: {
              __payload: 'LabelConnection',
              nodes: issue.labels.map((name) => ({ type: 'Label', name, color: repo.labels.get(name)?.color ?? 'ededed' })),
              pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
              totalCount: issue.labels.length,
            },
          } satisfies Source;
        }
        case 'comments': {
          return {
            type: 'Raw',
            value: {
              __payload: 'IssueCommentConnection',
              nodes: issue.comments.map((comment) => ({ type: 'IssueComment', repo, comment })),
              pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null },
              totalCount: issue.comments.length,
            },
          } satisfies Source;
        }
        case 'assignees': return { type: 'Raw', value: { __payload: 'UserConnection', nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: 0 } } satisfies Source;
        case 'milestone': return null;
        case 'repository': return { type: 'Repository', repo } satisfies Source;
        case 'createdAt': return issue.createdAt;
        case 'updatedAt': return issue.updatedAt;
        case 'closedAt': return issue.closedAt;
        case 'closed': return issue.state === 'closed';
        case 'locked': return false;
        case 'viewerDidAuthor': return true;
        case 'reactionGroups': return [];
        case 'participants': return { type: 'Raw', value: { __payload: 'UserConnection', nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: 0 } } satisfies Source;
        default: return undefined;
      }
    }
    case 'PullRequest': {
      const { repo, pull } = source as { repo: Repo; pull: PullRec };
      switch (field) {
        case 'id': return pullGlobalId(repo, pull);
        case 'databaseId': return pull.id;
        case 'number': return pull.number;
        case 'title': return pull.title;
        case 'body': return pull.body;
        case 'state': return pull.merged ? 'MERGED' : pull.state.toUpperCase();
        case 'merged': return pull.merged;
        case 'mergedAt': return pull.mergedAt;
        case 'mergeable': return pullMergeable(repo, pull);
        case 'headRefName': return pull.head;
        case 'baseRefName': return pull.base;
        case 'headRefOid': return branchTip(repo, pull.head) ?? '';
        case 'baseRefOid': return branchTip(repo, pull.base) ?? '';
        case 'mergeCommit': return pull.mergeCommitSha ? { type: 'Raw', value: { __payload: 'Commit', oid: pull.mergeCommitSha } } satisfies Source : null;
        case 'potentialMergeCommit': return null;
        case 'files': {
          const files = pullDiffFiles(repo, pull);
          const firstValue = args.get('first') ? resolveValue(args.get('first')!, ctx.vars) : undefined;
          const first = typeof firstValue === 'number' ? Math.trunc(firstValue) : files.length;
          const page = files.slice(0, first);
          return {
            type: 'Raw',
            value: {
              __payload: 'PullRequestFileConnection',
              nodes: page.map((file) => ({ type: 'Raw', value: { __payload: 'PullRequestFile', path: file.path, additions: file.additions, deletions: file.deletions, changeType: file.status === 'added' ? 'ADDED' : file.status === 'removed' ? 'DELETED' : 'MODIFIED' } })),
              pageInfo: { hasNextPage: files.length > page.length, hasPreviousPage: false, startCursor: null, endCursor: null },
              totalCount: files.length,
            },
          } satisfies Source;
        }
        case 'commits': return { type: 'Raw', value: { __payload: 'PullRequestCommitConnection', nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: 0 } } satisfies Source;
        case 'author': return { type: 'User' } satisfies Source;
        case 'url': return `https://forge.local/${login}/${repo.name}/pull/${pull.number}`;
        case 'repository': return { type: 'Repository', repo } satisfies Source;
        case 'createdAt': return pull.createdAt;
        case 'updatedAt': return pull.updatedAt;
        case 'closedAt': return pull.closedAt;
        case 'closed': return pull.state === 'closed';
        case 'locked': return false;
        case 'isDraft': return false;
        case 'additions': return pullDiffFiles(repo, pull).reduce((sum, f) => sum + f.additions, 0);
        case 'deletions': return pullDiffFiles(repo, pull).reduce((sum, f) => sum + f.deletions, 0);
        case 'changedFiles': return pullDiffFiles(repo, pull).length;
        case 'labels': return { type: 'Raw', value: { __payload: 'LabelConnection', nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: 0 } } satisfies Source;
        case 'comments': return { type: 'Raw', value: { __payload: 'IssueCommentConnection', nodes: [], pageInfo: { hasNextPage: false, hasPreviousPage: false, startCursor: null, endCursor: null }, totalCount: 0 } } satisfies Source;
        case 'headRepository':
        case 'baseRepository': return { type: 'Repository', repo } satisfies Source;
        case 'viewerDidAuthor': return true;
        default: return undefined;
      }
    }
    case 'IssueComment': {
      const { comment } = source as { comment: IssueRec['comments'][number] };
      switch (field) {
        case 'id': return globalId('IssueComment', String(comment.id));
        case 'databaseId': return comment.id;
        case 'body':
        case 'bodyText': return comment.body;
        case 'author': return { type: 'User' } satisfies Source;
        case 'url': return 'https://forge.local/comment';
        case 'createdAt': return comment.createdAt;
        case 'updatedAt': return comment.updatedAt;
        default: return undefined;
      }
    }
    case 'Ref': {
      const { name } = source as { name: string };
      if (field === 'name') return name;
      if (field === 'prefix') return 'refs/heads/';
      return undefined;
    }
    case 'Label': {
      const { name, color } = source as { name: string; color: string };
      if (field === 'name') return name;
      if (field === 'color') return color;
      if (field === 'id') return globalId('Label', name);
      if (field === 'description') return null;
      if (field === 'url') return 'https://forge.local/label';
      return undefined;
    }
    case '__Type': {
      const { name } = source as { name: string };
      if (field === 'name') return name;
      if (field === 'kind') return name === 'SearchType' ? 'ENUM' : 'OBJECT';
      if (field === 'description') return null;
      if (field === 'fields') {
        const fields = TYPE_FIELDS[name] ?? [];
        return fields.map((fieldName) => ({ type: 'Raw', value: { __payload: '__Field', name: fieldName, description: null, isDeprecated: false, deprecationReason: null } }));
      }
      if (field === 'enumValues') {
        const values = name === 'SearchType' ? SEARCH_TYPE_VALUES : [];
        return values.map((value) => ({ type: 'Raw', value: { __payload: '__EnumValue', name: value, description: null, isDeprecated: false, deprecationReason: null } }));
      }
      if (field === 'possibleTypes') return [];
      if (field === 'inputFields') return [];
      if (field === 'interfaces') return [];
      if (field === 'ofType') return null;
      return undefined;
    }
    case 'Raw': {
      const raw = source as { type: string; value?: unknown } | null;
      const value = raw !== null && raw.type === 'Raw' ? raw.value : raw;
      if (typeof value === 'object' && value !== null) {
        const record = value as Record<string, unknown>;
        if (field in record) return record[field];
      }
      return undefined;
    }
    default:
      return undefined;
  }
}

/** The GraphQL type name a resolved value carries into a sub-selection. */
function typeNameOf(value: unknown): string {
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    if (typeof record.__payload === 'string') return record.__payload;
    if (typeof record.type === 'string' && ('repo' in record || 'issue' in record || 'pull' in record || 'comment' in record || record.type === 'User' || record.type === 'Ref' || record.type === 'Label' || record.type === '__Type')) {
      return record.type;
    }
  }
  return 'Raw';
}

function executeSelection(typeName: string, source: Source, selection: FieldNode[], ctx: Ctx): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const field of selection) {
    if (field.name.startsWith('__inline:')) {
      const condition = field.name.slice('__inline:'.length);
      if (condition === typeName || condition === 'Node' || condition === 'Repository' || condition === typeNameOf(source)) {
        Object.assign(out, executeSelection(typeName, source, field.selection ?? [], ctx));
      }
      continue;
    }
    if (field.name.startsWith('__fragment:')) {
      const fragment = ctx.fragments.get(field.name.slice('__fragment:'.length));
      if (fragment) Object.assign(out, executeSelection(typeName, source, fragment.selection, ctx));
      continue;
    }
    const key = field.alias ?? field.name;
    if (field.name === '__typename') {
      out[key] = typeName;
      continue;
    }
    const isRaw = typeof source === 'object' && source !== null && (source as { type?: string }).type === 'Raw';
    const knownFields = TYPE_FIELDS[typeName];
    let value: unknown;
    if (isRaw || typeName === 'Raw') {
      value = resolveField('Raw', field.name, source, field.args, ctx);
      if (value === undefined) {
        out[key] = null;
        continue;
      }
    } else if (knownFields && !knownFields.includes(field.name)) {
      ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
      out[key] = null;
      continue;
    } else {
      value = resolveField(typeName, field.name, source, field.args, ctx);
      if (value === undefined) {
        ctx.errors.push({ message: `Field '${field.name}' doesn't exist on type '${typeName}'` });
        out[key] = null;
        continue;
      }
    }
    out[key] = completeValue(value, field, ctx);
  }
  return out;
}

function completeValue(value: unknown, field: FieldNode, ctx: Ctx): unknown {
  if (value === null || value === undefined) return null;
  if (Array.isArray(value)) return value.map((item) => completeValue(item, field, ctx));
  if (typeof value === 'object') {
    if (!field.selection) return value;
    const childType = typeNameOf(value);
    return executeSelection(childType, value as Source, field.selection, ctx);
  }
  return value;
}

// ---------------------------------------------------------------------------
// entry point
// ---------------------------------------------------------------------------

export interface GraphQLResult {
  data?: Record<string, unknown> | null;
  errors?: Array<{ message: string }>;
}

/** Execute one GraphQL document (one operation) with variables. */
export function executeGraphQL(query: string, variables: Record<string, unknown>, operationName?: string): GraphQLResult {
  let operations: Operation[];
  let fragments: Parser['fragments'];
  try {
    const parser = new Parser(query);
    operations = parser.parseDocument();
    fragments = parser.fragments;
  } catch (err) {
    return { errors: [{ message: err instanceof Error ? err.message : String(err) }] };
  }
  if (!operations.length) return { errors: [{ message: 'no operation in the document' }] };
  const operation = operationName ? operations.find((op) => op.name === operationName) ?? operations[0] : operations[0];
  const ctx: Ctx = { vars: variables, errors: [], fragments };
  const rootType = operation.type === 'mutation' ? 'Mutation' : 'Query';
  const data = executeSelection(rootType, null, operation.selection, ctx);
  const result: GraphQLResult = { data };
  if (ctx.errors.length) result.errors = ctx.errors;
  return result;
}

export { repoByName };
