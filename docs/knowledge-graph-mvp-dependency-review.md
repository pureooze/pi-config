# Knowledge graph MVP dependency and security review

**Review date:** 2026-08-06 baseline; rerun with the release validation on 2026-08-07

## Runtime dependency decision

The knowledge-graph extension adds no production dependency. It uses Node built-ins for SQLite (`node:sqlite`), hashing, filesystem permissions, paths, and process-local validation. SQLite is the Node-bundled driver; the extension does not download, load, or compile a database native module.

The package's direct entries are host/development dependencies already required by the Pi extension package:

| Package | Purpose | License | Runtime/native/network assessment |
|---|---|---|---|
| `@earendil-works/pi-agent-core@0.84.0` | Pi host peer/type surface | MIT | Host integration only; no knowledge-graph network call |
| `@earendil-works/pi-ai@0.84.0` | Pi host peer surface | MIT | Not imported by the knowledge graph; no model call |
| `@earendil-works/pi-coding-agent@0.84.0` | `ExtensionAPI` host types/runtime | MIT | Host package; the extension does not add a network path |
| `@earendil-works/pi-tui@0.84.0` | TUI result rendering | MIT | Host UI package; native console/clipboard prebuilds belong to the host dependency and are not used by storage |
| `typebox@1.3.7` | Runtime tool schemas | MIT | Pure schema dependency; no install script or native binary |
| `typescript@5.9.3` | Type-checking only | Apache-2.0 | Development only |
| `@types/node@24.12.4` | Type declarations only | MIT | Development only |

`package-lock.json` records these exact versions. `npm ls --depth=0 --omit=optional` reports no unmet direct dependencies. No dependency was added specifically for the knowledge graph.

## Install scripts and native artifacts

The locked Pi dependency tree contains install-script metadata for transitive host packages (`@google/genai` and `protobufjs`); the extension does not import either package. The documented isolated install command is `npm ci --ignore-scripts --legacy-peer-deps`, and the knowledge-graph test/smoke commands run offline. The host Pi package also carries platform-specific TUI/clipboard prebuilds; they are not part of the knowledge-graph persistence or retrieval path.

No extension file executes an install script, shell command, remote fetch, model call, or telemetry write. Search, proposal, review, export, restore, forget, and purge operate on the private local SQLite store only.

## Update policy

- Keep Pi peer/dev versions aligned with the supported Pi release (`0.84.0`) and review release notes before upgrading.
- Keep the Node floor at `>=24.14.1` because the extension depends on built-in `node:sqlite`.
- Do not add a runtime dependency for embeddings, a graph server, encryption, or a native SQLite binding during the MVP.
- Re-run `npm ci --ignore-scripts --legacy-peer-deps`, `npm run test:all`, and the offline Pi smoke test after dependency updates.
- Re-check licenses, install scripts, native artifacts, network behavior, and lockfile diff before accepting a dependency change.

Evidence: `package.json`, `package-lock.json`, `npm ls --depth=0 --omit=optional`, `npm run test:all`, and `npm run smoke:pi`.
