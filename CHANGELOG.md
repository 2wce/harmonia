# Changelog

## 0.1.1

### Patch Changes

- d8760bb: Require Changesets on user pull requests and publish releases when the generated release pull request is merged to main.
- b28072f: Build the package before packing or publishing so its declared `dist/` exports are included in the tarball.

All notable changes to Harmonia will be documented in this file.

## 0.1.0

- Scaffold the standalone package boundary.
- Define the transport-neutral protocol, lifecycle coordinator, watermark and
  bootstrap recovery behavior, and reusable adapter contract-test kit.
- Establish compatibility boundaries: changes to operation identity, outcome
  meaning, watermark behavior, or state transitions require a major version;
  optional wire fields may be added compatibly.
- Configure restricted npm publication through tagged CI releases only.
