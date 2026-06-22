# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

ImpactLens (`sf-advanced-search`) is a VS Code extension that provides search and dependency/impact analysis for Salesforce DX projects. It activates when a workspace contains `**/sfdx-project.json`. All user-facing IDs (commands, settings, views) use the `sfSearch.` prefix; the marketing name is "ImpactLens".

## Commands

```bash
npm run build      # esbuild production bundle (minified) — the runtime artifact
npm run watch      # incremental esbuild rebuild on save
npm run compile    # tsc type-check only (emits to out/, NOT used at runtime)
npm run lint       # eslint src/**/*.ts
npm run package    # vsce package → .vsix
```

There is **no test runner or test suite**. Validate changes with `npm run compile && npm run build`. `test-fixtures/sfdx-smoke/` is a minimal SFDX project for manual smoke testing. The `debug-*.js` files at the root are standalone Node scripts that replicate the tokenizer/search logic to reproduce matching bugs (gitignored, not shipped).

esbuild bundles **two entry points** (see `esbuild.js`): `src/extension.ts` → `dist/extension.js` and `src/indexing/indexWorker.ts` → `dist/indexWorker.js`. Both are required at runtime — if you add a new worker or runtime entry point, register it in `esbuild.js`.

## Architecture

Startup wiring is in [src/extension.ts](src/extension.ts): one `MetadataIndexer` is created and shared by `SearchEngine` and `ImpactAnalyzer`; then the `SearchPanel` (webview), the two tree views (`ResultsViewProvider`, `ImpactViewProvider`), and the language features (`SfCodeLensProvider`, `SfHoverProvider`) are wired on top.

Two parallel data structures power all search and analysis, both held in `MetadataIndexer`:

1. **Reference graph** — `Map<keyword, ReferenceEntry[]>` built from regex + XML parsing in [src/indexing/fileParser.ts](src/indexing/fileParser.ts). Precise, line-level results (real `line` numbers, snippets).
2. **MiniSearch full-text index** — `IndexDocument` records with a custom tokenizer that splits camelCase/PascalCase, underscores, and `Object.Field` dots. Broader recall but produces `line: 0` results.

`SearchEngine.search()` runs both, merges them, deduplicates by `filePath:line`, and scores graph hits at 100 (exact) / 50 (partial substring) ahead of MiniSearch's own scores. **`SearchResult.line` is `0` for MiniSearch-only hits — all UI/consumer code must handle line-less results.**

`ImpactAnalyzer.analyze()` walks the reference graph with multi-hop traversal (depth from `sfSearch.impactDepth`, default 3, max 5), cycle detection (a `visited` Set keyed on `filePath:line`), and a 0–100 risk score = reference-count factor + file-spread factor + depth factor + type-weight factor (`TYPE_RISK_WEIGHTS`, with test classes weighted 0.3×). Returns an `ImpactReport` (`riskLevel`, `riskScore`, `affectedFiles`, `hasCircularDeps`, `maxDepthReached`). `RiskLevel`: Low 0–24, Medium 25–49, High 50–74, Critical 75–100.

## Index persistence & worker

The index is persisted to `context.globalStorageUri/search-index.json` as a `SerializedIndex` (`version`, `timestamp`, `documents`, `referenceGraph`, `fileMtimes`). On `initialize()`, a cached blob is loaded only if its `version` matches `INDEX_VERSION` (currently **2** in [metadataIndexer.ts](src/indexing/metadataIndexer.ts)); otherwise a full rebuild runs. **Bump `INDEX_VERSION` whenever you change the serialized index schema.** After a successful load, `incrementalUpdate()` re-parses only files whose `fs.statSync().mtimeMs` exceeds the stored `fileMtimes`.

Full builds run parsing in a worker thread (`dist/indexWorker.js`), spawned with `workerData: { files, maxFileSize }`, communicating via the `WorkerMessageType` enum (`Progress` every 50 files, then `ParseComplete`). The worker strips `content` from returned `ParsedFile` objects to minimize memory transfer. If the worker can't load, `MetadataIndexer` falls back to `parseFilesMainThread()` transparently — incremental/single-file updates always use the main thread.

## Org search (separate from the local index)

`SalesforceService` ([src/services/salesforceService.ts](src/services/salesforceService.ts)) provides optional connected-org search, fully separate from the file index. **Gated** on the Salesforce CLI being available AND `sfSearch.enableToolingApi === true`. It builds an in-memory `CachedComponent[]` cache via parallel Tooling API queries (concurrency from `sfSearch.orgQueryConcurrency`), refreshed only by explicit user action. Org results have `filePath: ''` and `line: 0` — UI must not offer "Open File" for them.

## Conventions when extending

**Adding a new `MetadataType` requires lockstep edits across files:**
1. `MetadataType` enum — [src/models/searchResult.ts](src/models/searchResult.ts)
2. `classifyFile()` in [fileParser.ts](src/indexing/fileParser.ts) AND `SF_FILE_GLOBS` in [metadataIndexer.ts](src/indexing/metadataIndexer.ts)
3. `parseFile()` switch routing in [fileParser.ts](src/indexing/fileParser.ts) (to `parseApex` / `parseLwc` / `parseAura` / `parseVisualforce` / `parseXml`)
4. `FILTER_GROUPS` in [searchEngine.ts](src/search/searchEngine.ts)
5. `getMetadataIcon()` in [resultsView.ts](src/ui/resultsView.ts)

**Reference extraction:** all regex patterns live in [fileParser.ts](src/indexing/fileParser.ts) (Apex, LWC, Aura, Visualforce, Flow/XML). Extend the existing named patterns rather than adding ad-hoc search logic elsewhere.

**Webview protocol:** `SearchPanel` ([src/ui/searchPanel.ts](src/ui/searchPanel.ts)) embeds a large inline HTML/JS webview (~1600 lines). Webview→extension messages: `search`, `refreshOrgCache`, `openFile`, `copyText`. Extension→webview: `searchResults`, `orgCacheProgress`, `orgCacheRefreshed`, `setQuery`. The inline JS renderers consume the `SearchResult` shape directly — if you change `SearchResult` fields, update `handleSearch()`/`handleOrgSearch()` mapping AND the inline render functions.

**Security:** `SalesforceService` uses `execFile()` (never `exec()`); CLI args are always passed as string arrays. `sanitizeSoqlParam()` restricts input to `[a-zA-Z0-9_.]` before interpolating into SOQL. Never build shell command strings from user input.

**Misc:** Runtime deps are only `minisearch` and `fast-xml-parser`. Log via `vscode.OutputChannel` with bracketed prefixes (`[ImpactLens]`, `[Indexer]`, `[Search]`, `[Impact]`, `[SF]`). All settings live under `sfSearch.*` in `contributes.configuration`.
