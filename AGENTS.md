# Working in blssm.us

A [Blossom](https://github.com/hzrd149/blossom) server on Bunny Edge Scripting, with a Svelte SPA in `spa/`. See `README.md` for the API and configuration.

These steps are the default. Follow them without being asked.

## Delivering a change

1. **Start from fresh `origin/master`.** Use a new `fix/...`, `feat/...` or `docs/...` branch, with one concern per branch.
2. **Never push to `master`.** Every push there deploys to production (see [Deployment](#deployment)).
3. **Run the checks in [Verification](#verification).** CI only type checks and builds, so nothing else runs the tests.
4. **Update public claims** in the same PR (see [Public claims](#public-claims)).
5. **Commit, push and open a PR when the work is done.** Don't wait to be asked, and put `Fixes #N` in the body when it resolves an issue.
6. **Don't merge.** The owner merges.
7. **After the merge, verify on production** (see [Deployment](#deployment)) and report the result.

Write commit messages and PR titles as an imperative sentence that says what changes for the user, like the recent history. PR bodies cover what changed, the evidence, what wasn't verified, and any risk or client impact.

## Verification

Backend, for any change in `src/`:

```sh
deno test -A src/
deno task check
deno task build
```

SPA, for any change in `spa/`:

```sh
cd spa
bun install --frozen-lockfile
bun run check
node --test tests/
bun run build
```

- A bug fix needs a regression test. Confirm the test fails without the fix.
- Report failures and skipped steps as they are.
- Say what the tests can't prove. Behaviour at the Bunny edge can only be confirmed on production.

## Public claims

What we tell people has to match what the code does. When a change affects any of these, update them in the same PR.

| Claim | Where it lives |
| --- | --- |
| BUD support and status | `buds` in `spa/src/App.svelte` and the BUD table in `README.md` |
| Endpoints | `endpoints` in `spa/src/App.svelte` and the API table in `README.md` |
| Auth requirements | The auth section in `spa/src/App.svelte` and the Authentication section in `README.md` |
| Environment variables | The table in `README.md`; synced values also go in `.github/workflows/release-on-bunny.yml` |
| Moderation behaviour | `docs/moderation.md` |

The homepage and the README are written by hand and nothing generates them, so keep them in step with each other.

### BUD status

- Read the current spec in [`hzrd149/blossom/buds`](https://github.com/hzrd149/blossom/tree/master/buds) before changing a BUD or claiming support. Specs change, and related BUDs can set status codes and headers.
- **`full`** means every MUST in the spec has been checked against the code. List that check in the PR, with any deliberate deviation stated.
- **`partial`** means some of it works. Say in the PR what's missing.
- Fixing one rule from a BUD is not implementing it. Don't describe it that way.
- Remove the claim when support is removed.

## Scope and client impact

- **Reproduce issues first** where it's safe. Treat the reporter's diagnosis as a hypothesis and check it.
- **Report adjacent problems** rather than folding them into the change. Offer to file an issue.
- **Call out anything that rejects requests accepted today** in the PR, since it can break existing clients. Only ship it when it was asked for.

## Deployment

Merging to `master` deploys automatically:

- `release-on-bunny.yml` publishes the Edge Script and syncs config to Bunny env vars on every push.
- `deploy-spa.yml` deploys the SPA when `spa/**` changes.

After a merge, confirm the workflow succeeded, then exercise the changed behaviour against `https://blssm.us`.

Production checks must leave nothing behind. Use reads and requests that will be rejected, signed with public test key 1 (`0000000000000000000000000000000000000000000000000000000000000001`). Don't store blobs or change moderation state unless asked.

When a test upload has been approved, use a short, generic plain-text string typed by hand. Don't use images, documents or anything else that can carry EXIF or embedded metadata, don't put identifying details in the content or the token's tags, and delete the blob afterwards.

## Repo notes

- `.planning/` is a historical record that doesn't track current work, and parts of it are out of date. Trust the code over it, and leave it alone unless asked.
- Backend tests sit next to the code as `*.test.ts`. SPA tests are in `spa/tests/`.
