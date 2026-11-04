# Plugin format
Generate a directory with `workday-plugin.json` and the files named by its `skills` / `mcp` lists. Manifest example:
{"id":"report-tools","name":"Report tools","version":"1.0.0","description":"Summarize reports","descriptionZh":"整理报告摘要。","appVersion":"0.1","skills":["skills/report/SKILL.md"],"mcp":[]}

Each SKILL.md requires YAML `name` and `description`, followed by its complete Markdown workflow. Add a separate Chinese description at `metadata.description_zh`. Preserve the original description, other metadata and workflow. MCP files contain a configuration with `name`, `transport` (`stdio` or `http`), `command`, `args` and `url`, without credentials. A plugin may combine multiple components. Use meaningful IDs; same ID previews an update of the installed package with its expected version.

## Chinese descriptions
Keep the source description intact and fill missing Chinese descriptions for the Plugin and its declared Skills. Translate actual capabilities, triggers and important limits; an original fully Chinese description can be copied, while English text with a few Chinese trigger phrases still needs a complete Chinese version. Preserve existing nonblank Chinese text.

Use the field matching the actual package format:
- WorkDay `workday-plugin.json`: `descriptionZh`.
- Portable `plugin.json`: `extensions.workday.descriptionZh`; preserve other extensions.
- Supported legacy `.codex-plugin/plugin.json`: `descriptionZh`.
- Each declared `SKILL.md`: YAML `metadata.description_zh`.

For a complete selected package, use the original `materialToken` with a metadata-only supplement, for example:
{"materialToken":"<selected material token>","descriptionsZh":[{"path":"workday-plugin.json","descriptionZh":"整理报告摘要。"},{"path":"skills/report/SKILL.md","descriptionZh":"将提供的报告整理为主要发现与下一步行动。"}]}

Paths are relative to the selected material root. Only the installer's actual main manifest and declared Skill entries are allowed; do not target an alternate manifest merely because it exists, arbitrary files, absolute paths, `..`, or MCP configurations. A different existing nonblank Chinese value is rejected (the same value is an idempotent no-op). Omit entries that already have Chinese text. Keep the complete directory as `materialToken`, rather than rebuilding it as text `files`, so scripts, assets and binary resources remain intact. The supplement changes only the proposal copy, which the user reviews before installation. For newly generated `files`, write the matching field directly.

Call `workday_component_propose` with {"files":[{"path":"workday-plugin.json","content":"..."},{"path":"skills/report/SKILL.md","content":"..."}]}. Relative paths only; generated text is limited to 32 files and 128 KiB. Imported packages retain the existing 64 MiB / 5000-file boundary and their complete resources. Existing portable plugin.json and supported legacy packages are validated by the same installer. No remote downloads or automatic script/hook execution occur.
