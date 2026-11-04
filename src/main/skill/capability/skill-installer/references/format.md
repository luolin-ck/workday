# Skill format
A generated tree must include `SKILL.md` with YAML frontmatter containing `name` (lowercase letters, digits and hyphens) and a meaningful `description`. Add a separate Chinese description at `metadata.description_zh`; preserve other metadata, the original description, and the Markdown workflow. If the original description is already fully Chinese, it can be copied to the Chinese field. An English description containing a few Chinese trigger phrases still needs a complete Chinese description. Optional `references/`, `scripts/`, and `assets/` files support the workflow; avoid placeholders and redundant manuals.

Example proposal arguments:
{"files":[{"path":"SKILL.md","content":"---\nname: report-summary\ndescription: Summarize a supplied report into findings and next actions.\nmetadata:\n  description_zh: 将提供的报告整理为主要发现与下一步行动。\n---\n# Report summary\nRead the supplied report, preserve evidence and uncertainties, and summarize its findings and next actions.\n"}]}

For an existing complete directory, keep its resource tree intact and use a metadata-only supplement:
{"materialToken":"<selected material token>","descriptionsZh":[{"path":"SKILL.md","descriptionZh":"将提供的报告整理为主要发现与下一步行动。"}]}

The path is relative to the selected material root and must be the parsed Skill entry. Do not supply absolute paths, `..`, unrelated files or MCP configurations. The supplement only fills a missing or blank Chinese description; a different existing nonblank value is rejected (the same value is an idempotent no-op). If Chinese is already present, omit the supplement. Do not reconstruct the directory as text `files`, which can lose scripts or binary assets. The source directory is unchanged; the proposal shows the supplemented copy for user confirmation. New `files` proposals include the Chinese field directly rather than using this supplement.

Paths are relative, without `..` or symlinks. Generated text is limited to 32 files, 128 KiB total. Imported directories retain the existing 64 MiB / 5000-file limits. Same-name Skills are not silently overwritten: newly generated Skills use their own stable source identity, while importing the same source directory previews a versioned upgrade. Creating a same-name independent Skill is refused so the user can choose a distinct name or import its original source for an upgrade.
