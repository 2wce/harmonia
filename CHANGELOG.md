# Changelog

All notable changes to Harmonia will be documented in this file.

## 0.1.0

- Scaffold the standalone package boundary.
- Define the transport-neutral protocol, lifecycle coordinator, watermark and
  bootstrap recovery behavior, and reusable adapter contract-test kit.
- Establish compatibility boundaries: changes to operation identity, outcome
  meaning, watermark behavior, or state transitions require a major version;
  optional wire fields may be added compatibly.
- Configure restricted npm publication through tagged CI releases only.
