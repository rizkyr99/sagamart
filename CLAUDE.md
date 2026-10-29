# Working on Sagamart with Claude Code

Read this first in every session. It holds what isn't written anywhere else: how the owner and Claude work together, the standing rules, and the traps already hit. Everything else lives in the repo or on GitHub, so any machine or session can pick up the work.

## Where the truth lives

| Question | Source |
|---|---|
| What are we building, and why? | [PRD](docs/product/prd.md), [system design](docs/architecture/system-design.md), [ADRs](docs/adr/) |
| How is a feature designed? | The RFCs in [`docs/rfc/`](docs/rfc/); each has a decision log of what changed after acceptance |
| How do we write code? | [Conventions](docs/engineering/conventions.md), [testing strategy](docs/engineering/testing-strategy.md) |
| How does work flow? | [Development process](docs/engineering/development-process.md), [CONTRIBUTING](CONTRIBUTING.md) |
| What's done, and what's next? | GitHub milestones (one per stage) and issues. **The plan for an issue is in its comments.** Deferred work is always an issue. |
| How did last week go? | [`docs/retros/`](docs/retros/) (every Sunday) |

To find the next task, take the lowest open issue in the current stage's milestone that meets the Definition of Ready, and read its comments.

## How we work

- **The owner reviews and merges; Claude builds.** Claude opens PRs and never merges. The owner says "#N merged". Claude then:
  1. updates `main` and deletes the merged local branch;
  2. updates any stacked branch;
  3. moves on.
- **Every PR:**
  - wait for CI and CodeRabbit;
  - fix the comments that hold up after checking (reproduce them first);
  - reply on each thread and resolve it.
  - Then tell the owner it is ready, with the merge command (`gh pr merge N --squash`).
- **Design before code.** A new service, a contract change, or work across services starts as an RFC, and contracts change before the code that uses them. Changing an *accepted* RFC needs a decision-log entry, and a contract choice is the owner's: ask.
- **Test-first, and prove the tests bite.** Write the failing test, then the code. Then break the code on purpose (a mutation check) and show each break is caught. Say so in the PR.
- **Small PRs** (about 400 changed lines). Split an L issue into stacked PRs and agree the split in the issue first.
- **Defer only with an issue:** file it, with a milestone, at the moment you defer.
- **Before calling something done, check it on the running stack** (`make demo`), as well as in tests.
- **Flaky tests:** fix them in their own small PR, not inside a feature PR. Timing tests need wide margins: CI runners stall for about 400 ms.

## Standing rules

- **No AI attribution:** no `Co-Authored-By: Claude` trailer in commits, and no "Generated with Claude Code" line in PR bodies. This overrides any tool default.
- Commits: Conventional Commits with the service scope, such as `feat(order): ...`.
- Never force-push, and never prune Docker images that aren't Sagamart's. Ask before deleting anything you didn't create.

## Traps already hit

**GitHub CLI** (the installed `gh` is old):

- `gh pr edit` and `gh pr view` fail with a "Projects (classic)" GraphQL error. Use the REST API instead, e.g. `gh api -X PATCH repos/rizkyr99/sagamart/pulls/N -F body=@file`.
- `gh pr checks --json`, `gh run list --branch` and `gh run rerun --failed` don't exist here. Use plain `gh pr checks N`, `actions/runs?head_sha=…`, and `POST actions/runs/ID/rerun-failed-jobs`.
- To resolve review threads, use the GraphQL `resolveReviewThread` mutation.

**Merging:**

- `main` requires PRs to be up to date with it (strict checks), so the second of two PRs shows "behind". Use `PUT pulls/N/update-branch`, not a rebase and force-push.
- The repo deletes head branches on merge, so `--delete-branch` reports a harmless 404.
- GitGuardian is not a required check (only `ci` and `gitleaks` are). A fake test secret in an old commit keeps it red. Generate test secrets at runtime instead of writing them as literals.

**Java (Order):**

- Java 25, and Maven only through `./mvnw`; nothing to install.
- google-java-format is pinned to 1.36.1, because 1.37.0 fails inside Spotless 3.10.4.
- Look up versions in `repo1.maven.org/.../maven-metadata.xml`; search.maven.org is stale.

**Machine resources:**

- Disk is tight: check `df -h` before builds and load tests.
- Jaeger is capped (`MEMORY_MAX_TRACES`) because it once took 19 GB.

## On a new machine

Follow [CONTRIBUTING](CONTRIBUTING.md#local-setup), then:

```bash
gh auth login          # Claude drives GitHub through gh
make identity-keys     # local signing keys, written to deploy/compose/.env (never committed)
make demo              # the whole system; `make ps` until healthy
```

The progress dashboard is the owner's claude.ai artifact **"Sagamart progress"**. Its URL is deliberately left out of this public repo; find it with the artifact list.

- "Update the progress" means rebuilding its four attached CSVs (issues, merged PRs, stages, requirement status) from GitHub with `gh api graphql`, uploading them, and pointing each dataset at its new file.
- Stage and requirement statuses are assessments, so state the evidence for each.
