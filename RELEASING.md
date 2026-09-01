# Releasing Harmonia

Harmonia releases are versioned with Changesets and published through GitHub Actions. Normal releases require no npm token or local npm login.

## One-time repository governance

Configure these settings before normal OIDC releases:

1. Protect `main` so changes require pull requests and passing CI, including the
   `Changeset Check` workflow.
2. Create the `npm-release` environment and require at least one reviewer. Do
   not add an `NPM_TOKEN` secret.
3. After the initial package exists, open the `@2wce/harmonia` package settings
   on npm and add a Trusted Publisher using GitHub Actions. Select this GitHub
   repository, workflow `.github/workflows/release.yml`, and environment
   `npm-release`.

The package metadata must keep `repository.url` pointed at
`git+https://github.com/2wce/harmonia.git`. npm uses this value to associate the
package with the trusted GitHub publisher. The source repository also needs to
be public for npm provenance; npm does not support provenance from private
source repositories.

The normal release workflow does not require a tag or an npm token. The npm
Trusted Publisher and the `npm-release` environment are the publication
boundary.

## Release flow

1. Add a changeset with `pnpm changeset` and commit the generated file. The
   `Changeset Check` workflow requires this on every user pull request.
2. Merge the user pull request. The `Version` workflow creates or updates the
   Changesets release pull request on `main`.
3. Merge the generated `changeset-release/main` pull request. The `Release`
   workflow reruns the package checks, pauses for the `npm-release` environment
   approval, and publishes the version on the merged `main` commit with npm
   provenance.

## One-time first publication

npm cannot use Trusted Publishing to create the initial version of a package.
Before the first release only:

1. Create a short-lived npm granular access token with publish access. Do not
   use a personal login session or commit the token.
2. Create a protected GitHub `npm-bootstrap` environment, require an approval,
   and add the token as the `NPM_BOOTSTRAP_TOKEN` environment secret.
3. Run the `Bootstrap npm Package` workflow while `main` still contains the
   intended initial version (`0.1.0`). It publishes directly without
   provenance using the temporary token.
4. Revoke the npm token, delete the `NPM_BOOTSTRAP_TOKEN` secret, and remove
   the `npm-bootstrap` environment and `bootstrap.yml` workflow.
5. Make the source repository public, then configure the npm Trusted Publisher
   described above. Future releases use OIDC and provenance through
   `release.yml` only.

Do not rerun the bootstrap workflow after a successful publication; the same
package version cannot be published twice.

The package is public, and the release workflow has no long-lived npm credential.
