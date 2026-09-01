# Releasing Harmonia

Harmonia releases are versioned with Changesets and published through GitHub Actions. No npm token or local npm login is required.

## One-time repository governance

Configure these settings before the first release:

1. On npm, open the `@2wce/harmonia` package settings and add a Trusted Publisher using GitHub Actions. Select this GitHub repository, workflow `.github/workflows/release.yml`, and environment `npm-release`.
2. In GitHub, create the `npm-release` environment and require at least one reviewer. Do not add an `NPM_TOKEN` secret.
3. Protect `main` so changes require pull requests and passing CI.
4. Protect `v*` tags so only approved maintainers can create release tags.

## Release flow

1. Add a changeset with `pnpm changeset` and commit the generated file.
2. Merge the Changesets version pull request created by the `Version` workflow.
3. Create and push the matching tag from the updated `main` commit:

```bash
version="$(node -p "require('./package.json').version")"
git tag -a "v${version}" -m "Release v${version}"
git push origin "v${version}"
```

4. The `Release` workflow reruns the package checks, verifies the tag matches `package.json`, pauses for the `npm-release` environment approval, and publishes with npm provenance.

The package is public, and the release workflow has no long-lived npm credential.
