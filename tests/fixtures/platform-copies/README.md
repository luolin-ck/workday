# Optional local platform-copy fixtures

`source-trees.json.gz` is an optional, ignored local fixture containing exact third-party resource trees used to verify three legacy copies (Skill Creator, Skill Installer, Plugin Management 0.1.0). The raw resource trees are omitted from this repository until their redistribution permissions are confirmed; WorkDay's MIT license does not grant rights to those third-party materials.

Without this fixture, seven exact-copy, migration, backup and import checks in `tests/platform-capabilities.test.ts` are explicitly skipped. The two independent tests for forged legacy authority and mixed management/business context still run. Other test files remain enabled. No replacement golden data or production fingerprints are generated.

When a separately authorized fixture is available locally, those checks unpack it into isolated temporary directories. Neither runtime nor tests read Codex installation paths. Fingerprints remain in `src/main/platform-copies.ts`. Tests never execute scripts or invoke the tool names in these documents.
