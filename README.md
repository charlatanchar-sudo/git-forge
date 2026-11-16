# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/charlatanchar-sudo/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/charlatanchar-sudo/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A self-contained, GitHub-compatible git forge in a single Node process, built for the make.fun `github-core-clone-01` bounty. It implements git itself — object store, packfiles, the smart-HTTP protocol (v0 and v2) — plus the GitHub REST v3 API, the GraphQL v4 API, and an MCP (JSON-RPC) tool endpoint, with no dependencies, no external services and no git binary. On the official kit's local suite it passes 120/120 conformance checks (feature and agent/MCP sections at full marks), and a real git client can clone, push, pull and shallow-clone against it.

## Run it

```sh
node main.ts
```

`main.ts` binds an ephemeral port, registers it with `$MAKEFUN_ENV_URL/register`, and polls `$MAKEFUN_ENV_URL/done` until the run ends. For local use, any HTTP server can mount `createApp()` from `app.ts`.

## Layout

| File        | Role |
| ----------- | ---- |
| `main.ts`   | Entrypoint: listen, register with the env, poll for done. |
| `app.ts`    | HTTP surface: REST v3 routes, git smart-HTTP routing, GraphQL and MCP endpoints, auth, pagination. |
| `core.ts`   | In-memory store and the git object model: SHA-1 objects, trees/commits, reachability, merge-base, three-way tree merges. |
| `gitp.ts`   | The wire protocol: pkt-lines, packfile read/write (incl. OFS/REF deltas), protocol v0/v2 advertisements, `ls-refs`, fetch planning with shallow support, receive-pack with fast-forward checks. |
| `domain.ts` | Issues, pull requests, comments, diffs and merges shared by REST, GraphQL and MCP. |
| `gql.ts`    | A small GraphQL parser/executor covering the query surface the API exposes (connections, mutations, introspection, batched operations). |

## Design notes

- **Storage is in-memory.** A run starts empty and the environment drives all
  state through the APIs, so no disk layout is needed; object graphs are held as
  `Map`s keyed by hex oid, with parsed trees/commits cached per object.
- **Git is implemented, not shelled out.** Packfiles are written with a
  content-addressed pack cache; the reader resolves OFS-delta and REF-delta
  chains, so real git clients can push to it, and fetch computes the want/have
  closure itself, including shallow boundaries and `deepen`/`unshallow`
  bookkeeping.
- **One identity.** The first repo-addressed request binds the scenario's viewer
  login as the owner of the shared repo pool, mirroring how the kit's single
  user drives every surface.
- **Auth.** When `MAKEFUN_SHOP_TOKEN` is set, API calls must present it as a
  Bearer token; git transport routes are unauthenticated, as real git clients
  send no credentials there.

## License

MIT — see [LICENSE](LICENSE).

---

Entered on [make.fun](https://make.fun/?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards
