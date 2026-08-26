# Harmonia

Harmonia is a neutral, local-first synchronization kernel for applications
that need durable local operations, dependency-aware delivery, scoped remote
change consumption, explicit recovery, and visible conflict outcomes.

It is distributed as the private scoped npm package `@2wce/harmonia`.

## Installation

```bash
pnpm add @2wce/harmonia
```

The package targets modern browsers, Web Workers, Node.js, and Electron
utility processes. It is ESM-only and has no runtime framework, database,
transport, or product dependencies.

## Coordinator lifecycle

An application adapter and transport drive a synchronization run through six
steps:

1. Select dependency-ready local operations in bounded batches.
2. Claim those operations durably before delivery.
3. Push the batch and apply each acknowledgement by operation identity.
4. Pull remote changes from the scope's stored opaque cursor.
5. Apply the complete change batch and advance its cursor atomically.
6. Emit lifecycle outcomes for progress, retry, rejection, conflict, bootstrap,
   and connection state.

Cancellation leaves in-flight work inspectable. Invalid or compacted history
produces an explicit bootstrap-required outcome; Harmonia never silently skips
unavailable changes.

## Adapter responsibilities

The product adapter owns durable storage, transactions, authentication and
authorization, domain validation, domain writes, conflict resolution, and
derived projections. The transport adapter owns the remote protocol, request
authentication, and transport error information. Scopes, entities, payloads,
versions, cursors, and conflict policy remain opaque or product-defined at the
Harmonia boundary.

## Explicit exclusions

Harmonia does not transfer files or EPUB bytes, refresh credentials, write to a
database, rebuild search indexes, or resolve domain conflicts. It reports
rejections and conflicts so the product can apply its own policy. Product
adapters remain responsible for domain rules, rich conflict merging, and
separate binary content flows.
