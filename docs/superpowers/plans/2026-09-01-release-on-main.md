# Governed Main-Branch Release Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Require a Changeset on every user pull request and publish Harmonia automatically when the generated Changesets release pull request is merged to `main`, without local npm credentials or manual release tags.

**Architecture:** Keep Changesets responsible for collecting release intent and generating the version pull request. Add a lightweight pull-request gate that checks for a non-README Changeset file, exempting only the generated release pull request. Move npm publication from tag pushes to the merge event for `changeset-release/main`. Because npm cannot OIDC-publish a package that does not exist yet, use a separate one-time, protected bootstrap workflow with a short-lived token for `0.1.0`; remove that workflow and token after the package is created. The normal publish job remains behind the `npm-release` GitHub environment and uses npm OIDC provenance.

**Tech Stack:** GitHub Actions, Changesets, pnpm, npm Trusted Publishing/OIDC, Node.js 24.

**Spec:** `RELEASING.md` and the repository’s Changesets configuration.

## Global Constraints

- No local npm login and no long-lived `NPM_TOKEN`.
- The npm Trusted Publisher must match repository `2wce/harmonia`, workflow `.github/workflows/release.yml`, and environment `npm-release` after the initial package exists.
- Every user pull request must add a `.changeset/*.md` file; `.changeset/README.md` does not count.
- The generated Changesets release pull request is the only pull request exempt from the Changeset gate.
- Publication uses `npm publish --access public --provenance`.
- The release and one-time bootstrap jobs must rerun the package verification checks before publishing.

### Task 1: Require Changesets on pull requests

**Files:**

- Create: `.github/workflows/changeset-check.yml`

**Interfaces:**

- Consumes: `pull_request.base.sha`, `pull_request.head.sha`, and the checked-out Git history.
- Produces: A required GitHub check that passes only when the pull request changes a real Changeset file, or when the pull request is the generated `changeset-release/main` release pull request.

- [ ] **Step 1: Add the pull-request workflow**

Create a workflow that checks out the pull-request head with full history, diffs the base and head SHAs, and fails with an actionable message when no `.changeset/<name>.md` file other than `README.md` is present. Treat `changeset-release/main` as an explicit generated-release exception.

- [ ] **Step 2: Verify the workflow’s matching rules locally**

Run the equivalent filename filter against the repository and confirm that `.changeset/README.md` is excluded and future generated Changesets files would be included.

### Task 2: Publish on the release pull request merge

**Files:**

- Modify: `.github/workflows/release.yml`

**Interfaces:**

- Consumes: A merged pull request whose base is `main` and whose head is `changeset-release/main`, plus the existing package scripts.
- Produces: A protected, OIDC-authenticated npm publication for the version present on the merged `main` commit.

- [ ] **Step 1: Change the trigger and authorization boundary**

Replace the tag-only trigger with `pull_request` `closed`. Require `contents: read` and `id-token: write`; put the publish job in the `npm-release` environment. Allow the job only for a merged `changeset-release/main` pull request targeting `main`.

- [ ] **Step 2: Keep verification before publication**

Check out the merge commit, verify typechecking, tests, lint, formatting, and package exports, then run `npm publish --access public --provenance`. Verify that the package version is read from the checked-out `package.json`; do not reintroduce tags or npm tokens as release inputs.

- [ ] **Step 3: Add the one-time bootstrap path**

Create `.github/workflows/bootstrap.yml` with a manual dispatch, protected `npm-bootstrap` environment, and `NPM_BOOTSTRAP_TOKEN` secret. Check out `main` and publish directly with `--provenance=false`; do not add package assertions, registry preflights, or verification steps to this one-time bootstrap. Remove the workflow, environment, and token after publishing `0.1.0`.

### Task 3: Document the new release contract and add a workflow changeset

**Files:**

- Modify: `RELEASING.md`
- Create: `.changeset/ci-release-flow.md`

**Interfaces:**

- Consumes: The workflow behavior from Tasks 1 and 2.
- Produces: Contributor instructions that describe the PR gate, version PR, merge-triggered publication, npm environment setup, and one-time bootstrap dispatch.

- [ ] **Step 1: Update release documentation**

Remove manual tag creation from the normal flow. Document that every user pull request needs a Changeset, the `Version` workflow creates or updates the release pull request on `main`, and merging that generated pull request runs the protected npm publication. Explain the one-time bootstrap dispatch for `0.1.0`.

- [ ] **Step 2: Add a patch Changeset for this release-process change**

Add a valid Changesets markdown file declaring a patch release for `@2wce/harmonia`, so this workflow change itself satisfies the new pull-request check and is included in the next package release.

### Task 4: Verify the release workflow change

**Files:**

- Test: `.github/workflows/changeset-check.yml`, `.github/workflows/release.yml`, `RELEASING.md`, `.changeset/ci-release-flow.md`

- [ ] **Step 1: Run repository checks**

Run `pnpm typecheck`, `pnpm test`, `pnpm lint`, `pnpm format:check`, and `pnpm pack:check`.

- [ ] **Step 2: Inspect the final diff**

Run `git diff --check` and review that the release workflow has no `NPM_TOKEN`, no tag-only release path, and the exact `npm-release` environment/OIDC permissions remain present.

- [ ] **Step 3: Commit the change**

Commit the workflow, documentation, plan, and Changeset together with:

```bash
git add .github/workflows/changeset-check.yml .github/workflows/release.yml RELEASING.md .changeset/ci-release-flow.md docs/superpowers/plans/2026-09-01-release-on-main.md
git commit -m "ci: release on changeset merge"
```
