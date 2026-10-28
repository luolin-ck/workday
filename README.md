# WorkDay

**In development: the first version is not complete.** This repository shares the source code for ongoing development. There is no official release or installer, and interfaces, data formats, and behavior may change.

English | [简体中文](README.zh-CN.md)

WorkDay is a local desktop workspace that brings a monthly calendar, tasks, AI conversations, and project context together. It is built with Electron, React, TypeScript, and SQLite through sql.js. The interface is currently primarily in Chinese.

## What is being built

- **Calendar and tasks:** daily tasks, notes, deadlines, completion and undo, lunar dates, solar terms, holidays, and city weather. Holiday names and official rest/workday arrangements are displayed separately.
- **AI conversations:** streaming Chat Completions compatible model sources, attachments, selected conversation context, task drafts, and chat archiving.
- **Project context:** local folders and GitHub repositories, bounded file browsing and search, and single-file text create/update proposals that require explicit confirmation. The application does not automatically commit or push project changes.
- **Knowledge and extensions:** selected Markdown/text knowledge, instruction-based Skills, authorized MCP tools/resources, and local declarative Plugin packages.
- **Runtime schedules:** one-time, daily, weekly, and biweekly tasks with a selected model, context, and tool permissions.
- **Local data:** SQLite persistence and validated backup copies that exclude credentials and tool authorizations, plus configurable themes and background images.

These features are still evolving. Their presence in the source does not imply that the first version has passed a complete acceptance review.

## Development requirements

- **macOS:** the current build compiles Swift helpers for file access, attachments, image conversion, and Keychain access. A complete Windows or Linux build is not currently supported.
- **Xcode Command Line Tools:** `xcrun`, the macOS SDK, Swift compiler, and `codesign` must be available. Install the tools with `xcode-select --install` if needed.
- **Node.js 22.12 or newer**, with Node.js 24 recommended, and npm.
- Network access for the initial dependency installation. Real AI services require your own compatible endpoint and, where applicable, credentials.

## Run from source

```sh
git clone https://github.com/luolin-ck/workday.git
cd workday
npm ci --legacy-peer-deps --registry=https://registry.npmjs.org --cache=.npm-cache
npm run build
WORKDAY_DATA_DIR="$PWD/test-data/development" npm start
```

The last command uses an isolated development data directory. To use the normal application data directory instead, run `npm start` without `WORKDAY_DATA_DIR`. Rebuild after changing the source.

### Try the local mock model

Run the following in a separate terminal:

```sh
npm run mock
```

In WorkDay, open **设置 → 模型源** (Settings → model sources) and add a source manually:

| Field | Value |
| --- | --- |
| Base URL | `http://127.0.0.1:4319/v1` |
| Model ID | `workday-mock` |
| API key | Leave empty |
| Tools | Enable support explicitly |

This is an explicit local simulation, not a real AI model. Stop it with Ctrl+C. For a real model source, supply a Chat Completions compatible Base URL, model ID, and any required API key. Prefer HTTPS: HTTP sends credentials and conversation content without transport encryption. Tools support must be selected explicitly for each model.

### Generate the example Plugin

```sh
node scripts/create-example.cjs
```

This creates `examples/summary-plugin` with a summary Skill and a local mock MCP connection. The generated configuration contains the current Node executable and project paths, so it is excluded from Git and must be regenerated after moving the checkout. Import the generated folder through the Plugin page. Its MCP connection remains disabled until explicitly enabled, discovered, and authorized.

## Checks

```sh
npm run typecheck
npm test
npm run build
```

Tests use synthetic fixtures; some integration tests need local loopback listeners, and native helper tests need the macOS development tools. Test and application data, generated builds, and verification output are excluded from Git.

Seven legacy platform-copy checks require an optional local third-party fixture that is excluded pending redistribution review; a clean clone explicitly skips those checks. Independent platform permission tests still run. See the [fixture coverage note](tests/fixtures/platform-copies/README.md). The current development baseline also has known failing checks for corrupt-history submission and a missing theme CSS variable; `npm test` is not yet fully passing.

The optional desktop smoke check uses Playwright's Electron API:

```sh
npm run smoke
```

It requires an already available Playwright module; alternatively, set `WORKDAY_PLAYWRIGHT_MODULE` to its module path. It uses isolated data under `test-data/` and writes results under `output/playwright/`. It also checks the public government holiday service, so it needs network access. Running this command is a development check, not a complete product acceptance test.

## Data and service boundaries

- Without an override, data lives in Electron's WorkDay userData directory, typically `~/Library/Application Support/WorkDay` on macOS. `WORKDAY_DATA_DIR` selects a separate directory at startup for development or restored backup copies.
- Model and GitHub credentials are stored separately from business data using the operating system's secure storage through Electron safeStorage and macOS Keychain integration. Credential storage is refused if secure storage is unavailable. Credentials and authorizations are excluded from business backups.
- Local storage does not make AI requests local. Selected messages, attachments, knowledge, and project content are sent to the configured model source when used. Review the data you select and the services you trust.
- Project text changes require an explicit **应用到文件夹** (Apply to folder) confirmation. File selection filters and size limits reduce exposure but are not a complete secret detector.
- MCP discovery does not grant access. Authorize specific tools/resources for a conversation or schedule. Trust the server's actual behavior; a “read-only” description cannot prove the absence of external side effects.
- Weather uses ipwho.is for approximate network-exit location and Open-Meteo for city search and forecasts. These services receive the relevant network address or city coordinates. Official Chinese rest/workday arrangements are queried from government sources.
- Schedules run while the application is running and awake. Missed times while the app is closed or the computer sleeps are recorded, not replayed automatically. There is no always-on service after exit.
- Restoring a backup creates a separate copy; it does not overwrite the original database. Restored model/MCP sources are disabled, authorizations are cleared, and schedules are paused.

## Current limits

The first version is unfinished. Compatibility with arbitrary model endpoints and MCP servers is not guaranteed. The UI and calendar conventions currently focus on Chinese-language use; some native calendar integration also depends on local macOS calendar configuration.

There is no cloud synchronization, account system, online Plugin marketplace, arbitrary Plugin script execution, or unattended project commit/push. Local Plugin support is declarative. Large conversations, attachments, and backups have size limits; sql.js persistence is intended for a personal local workload.

The package's `0.1.0` value is development metadata, not an announced release. This repository does not provide signed/notarized installation packages or a production-readiness promise.

## Source guide and contributing

| Path | Purpose |
| --- | --- |
| `src/main/` | Electron services, persistence, model requests, project access, and extensions |
| `src/preload/` | Renderer bridge |
| `src/renderer/` | React interface, themes, and interaction |
| `src/shared/` | Shared types, protocols, and date rules |
| `native/` | macOS Swift helper sources |
| `tests/` and `scripts/` | Tests, fixtures, build, and verification tools |

Before contributing, read the [development conventions](AGENTS.md). See [theme customization](docs/theming.md) and [platform capabilities](docs/platform-capabilities.md) for implementation details. Keep credentials, personal data, generated artifacts, and local verification output out of commits. Development fixes and documentation improvements are welcome; the project is still working toward its first version.

## License

WorkDay's original source is available under the [MIT License](LICENSE), copyright © 2026 luolin-ck. Third-party components retain their own licenses. In particular, the bundled Lucide/Feather icon notices are preserved in [public/lucide-LICENSE.txt](public/lucide-LICENSE.txt).
