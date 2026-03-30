# Copilot Instructions for ImpactLens (`sf-advanced-search`)

## Architecture
- VS Code extension for Salesforce DX projects. Activates on `**/sfdx-project.json` (see `activationEvents` in `package.json`).
- Startup wiring in `src/extension.ts`: creates `MetadataIndexer` → passes it to `SearchEngine` + `ImpactAnalyzer`, then wires up `SearchPanel` (webview), `ResultsViewProvider` + `ImpactViewProvider` (tree views), `SfCodeLensProvider` + `SfHoverProvider` (language features).
- Two data structures power search:
  1. **Reference graph** — `Map<keyword, ReferenceEntry[]>` built from regex/XML parsing in `fileParser.ts`. Precise, line-level results.
  2. **MiniSearch full-text index** — `IndexDocument` records with custom camelCase/underscore/dot tokenizer. Broader recall, `line: 0` results.
- `SearchEngine.search()` merges both, deduplicating by `filePath:line`, scores graph hits at 100 (exact) / 50 (partial) vs MiniSearch's own score. Also provides `exportResults()` (CSV/JSON/Markdown) and `addToHistory()` / `getHistory()` for search history tracking.
- Impact analysis (`impactAnalyzer.ts`) walks the reference graph with **multi-hop traversal** (configurable depth via `sfSearch.impactDepth`, max 5), **cycle detection** (visited set on `filePath:line`), and **risk scoring** (0-100, based on type weights, file spread, depth, test vs production). Returns `ImpactReport` with `riskLevel`, `riskScore`, `affectedFiles`, `hasCircularDeps`, `maxDepthReached`. Supports `exportReport()` in CSV/JSON/Markdown.

## Build & Validation
- esbuild bundles **two entry points** (`esbuild.js`): `src/extension.ts` → `dist/extension.js` and `src/indexing/indexWorker.ts` → `dist/indexWorker.js`.
  - `npm run build` — production build (minified, no sourcemaps)
  - `npm run watch` — incremental rebuild on save
  - `npm run compile` — `tsc` type-check only (output to `out/`, not used at runtime)
  - `npm run lint` — ESLint on `src/**/*.ts`
  - `npm run package` — `vsce package` to produce `.vsix`
- **No test runner or test suite exists.** Validate changes with `npm run compile && npm run build`.
- Smoke-test fixtures live in `test-fixtures/sfdx-smoke/` (a minimal SFDX project structure).

## Adding a New Metadata Type (multi-file checklist)
When adding a new `MetadataType`, update all four locations in lockstep:
1. **Enum** — `MetadataType` in `src/models/searchResult.ts`
2. **File classification** — `classifyFile()` in `src/indexing/fileParser.ts` (extension/path matching) and `SF_FILE_GLOBS` in `src/indexing/metadataIndexer.ts` (discovery glob)
3. **Parser routing** — `parseFile()` switch in `src/indexing/fileParser.ts` (route to appropriate parser: `parseApex`, `parseLwc`, `parseAura`, `parseVisualforce`, or `parseXml`)
4. **Filter groups** — `FILTER_GROUPS` in `src/search/searchEngine.ts` (decides which UI filter toggles include the type)
5. **Icon mapping** — `getMetadataIcon()` in `src/ui/resultsView.ts` (ThemeIcon + ThemeColor per type)

## Webview ↔ Extension Message Protocol
`SearchPanel` (`src/ui/searchPanel.ts`) embeds a large inline HTML/JS webview (~1600 lines). Messages:
- **Webview → extension:** `search` (with `query`, `filters`, `exactMatch`, `searchMode`), `refreshOrgCache`, `openFile` (with `filePath`, `line`), `copyText`
- **Extension → webview:** `searchResults`, `orgCacheProgress`, `orgCacheRefreshed`, `setQuery`
- The webview JS renderers consume the same result shape (`fileName`, `filePath`, `line`, `snippet`, `metadataType`, `objectName`, `score`). If you change `SearchResult` fields, update the mapping in `handleSearch()` / `handleOrgSearch()` AND the inline JS render functions.

## Reference Extraction Patterns
All regex patterns for Salesforce reference extraction live in `src/indexing/fileParser.ts`:
- Apex: `SF_API_NAME_PATTERN`, `SOQL_FROM_PATTERN`, `SOQL_SELECT_FIELDS`, `APEX_CLASS_REF`, `APEX_NEW_INSTANCE`, `APEX_TRIGGER_DECL`, `APEX_CLASS_DECL`, `APEX_METHOD_DECL`
- LWC: `LWC_SF_IMPORT` (`@salesforce/*`), `LWC_COMPONENT_IMPORT` (`c/*`), HTML `<c-*>` tags
- Aura: `AURA_COMPONENT_REF`, `AURA_ACTION`
- Visualforce: `VF_CONTROLLER`, `VF_EXTENSIONS`, `VF_INPUT_FIELD`, `VF_ACTION`, `VF_COMPONENT_REF` — parsed by dedicated `parseVisualforce()` function
- Flow/XML: `FLOW_REF_TAGS` (actionName, apexClass, flowName, object, objectType, targetReference, assignToReference, processMetadataValues) plus `fast-xml-parser` deep extraction
- **Always** extend these patterns rather than adding ad-hoc search logic elsewhere.

## Security
- `SalesforceService` uses `execFile()` (not `exec()`) to prevent shell injection. All CLI commands pass arguments as string arrays.
- `sanitizeSoqlParam()` validates input against `[a-zA-Z0-9_.]` before interpolating into SOQL queries.
- Never construct shell command strings from user input.

## Impact Analysis & Risk Scoring
- `ImpactAnalyzer.analyze()` performs multi-hop traversal of the reference graph:
  - Depth is configurable via `sfSearch.impactDepth` (default 3, max 5).
  - Cycle detection via `visited` Set keyed on `filePath:line`.
  - At each hop, follows references by extracting the base filename (sans extension) and recursively walking.
- Risk scoring algorithm (0-100): reference count factor (max 30pts) + file spread factor (max 25pts) + depth factor (max 15pts) + type weight factor (max 30pts, weighted by `TYPE_RISK_WEIGHTS` map, test classes at 0.3× weight).
- `RiskLevel` enum: Low (0-24), Medium (25-49), High (50-74), Critical (75-100).
- `exportReport()` supports CSV, JSON, Markdown formats.

## CodeLens & Hover Providers
- `SfCodeLensProvider` (`src/ui/codeLensProvider.ts`): shows reference counts above Apex class/trigger/interface declarations and LWC/Aura component files. Controlled by `sfSearch.enableCodeLens` setting.
- `SfHoverProvider` (`src/ui/hoverProvider.ts`): shows mini impact summary (reference count, file count, types) when hovering over Salesforce API names. Includes clickable commands for Search and Analyze Impact.
- Both registered for Apex, LWC JS/HTML, Aura CMP, and Visualforce languages in `extension.ts`.

## Index Persistence & Cache Invalidation
- Persisted to `context.globalStorageUri/search-index.json` as a `SerializedIndex` (defined in `src/models/searchResult.ts`).
- `SerializedIndex` contains: `version` (currently `INDEX_VERSION = 1` in `metadataIndexer.ts`), `timestamp`, `documents`, `referenceGraph`, and `fileMtimes`.
- On `initialize()`: loads cached JSON → checks `version` field — if it differs from `INDEX_VERSION`, the cache is discarded and a full rebuild runs. **Bump `INDEX_VERSION` when you change the index schema.**
- After a successful cache load, `incrementalUpdate()` compares every discovered file's `fs.statSync().mtimeMs` against stored `fileMtimes`. Only stale files are re-parsed (main-thread fallback) and patched into the live index.
- `persistIndex()` is called after both full builds and incremental updates; writes the entire `SerializedIndex` as a single JSON blob.
- `removeFileFromIndex()` strips a file from `indexedDocuments`, `searchIndex` (MiniSearch), `referenceGraph` (all entries where `filePath` matches), and `fileMtimes`.

## Worker Thread Protocol
- The worker entry point is `src/indexing/indexWorker.ts`, bundled to `dist/indexWorker.js`.
- Main thread spawns a `Worker` with `workerData: { files: FileEntry[], maxFileSize: number }`.
- Communication uses `WorkerMessageType` enum (`src/models/searchResult.ts`):
  - Worker → main: `Progress` (payload `{ processed, total }`) — sent every 50 files (batch size).
  - Worker → main: `ParseComplete` (payload `{ parsed: ParsedFile[], errors: Array<{file, error}> }`) — final message, terminates the worker.
- If the worker fails to load (e.g., missing `dist/indexWorker.js`), `MetadataIndexer` falls back to `parseFilesMainThread()` transparently.
- Worker strips `content` from returned `ParsedFile` objects (`content: ''`) to minimize memory transfer; full-text content is indexed separately via `references` and `methods` fields.

## Org Search & SalesforceService Cache
- `SalesforceService` (`src/services/salesforceService.ts`) provides optional connected-org search, completely separate from the local file index.
- **Gating:** CLI must be available (`sf version` or `sfdx version`) AND `sfSearch.enableToolingApi` must be `true`.
- **Cache lifecycle:** On first `searchOrg()` call, `buildOrgCache()` queries 8 Tooling API types in **parallel batches** (concurrency controlled by `sfSearch.orgQueryConcurrency`, default 3) with `LIMIT 2000` each. Results are stored as `CachedComponent[]` in memory.
- **Progress:** Each metadata type fires `onProgress(label, done, total)` → forwarded as `orgCacheProgress` webview messages for a per-type progress bar.
- **Search:** `searchOrgCache()` is a synchronous in-memory substring search: all query terms must appear in either `name` or `body`. Scoring: exact name = 100, partial name = 50, body-only = 10. Results capped at 200.
- **Refresh:** Cache is invalidated only by explicit user action (`refreshOrgCache` command / button), never on a timer.
- Org search results have `filePath: ''` and `line: 0` — UI code must handle these gracefully (no "Open File" action).

## Coding Conventions
- All user settings are under the `sfSearch.*` namespace — see `contributes.configuration` in `package.json` (e.g., `sfSearch.excludePatterns`, `sfSearch.maxFileSize`, `sfSearch.debounceDelay`, `sfSearch.enableToolingApi`, `sfSearch.fuzzyTolerance`, `sfSearch.impactDepth`, `sfSearch.orgQueryConcurrency`, `sfSearch.enableCodeLens`).
- Use `vscode.OutputChannel` with prefixes: `[ImpactLens]`, `[Indexer]`, `[Search]`, `[Impact]`, `[SF]`.
- `SearchResult.line` is `0` for MiniSearch-only hits — all UI code must handle line-less results.
- Dependencies: `minisearch` (full-text), `fast-xml-parser` (XML metadata). No other runtime deps.
- All commands use the `sfSearch.` prefix. Tree view IDs: `sfSearch.resultsView`, `sfSearch.impactView`.
- Commands: `sfSearch.search`, `sfSearch.impactAnalysis`, `sfSearch.analyzeImpact`, `sfSearch.fieldUsage`, `sfSearch.objectUsage`, `sfSearch.rebuildIndex`, `sfSearch.searchFromEditor`, `sfSearch.searchSelection`, `sfSearch.exportImpact`, `sfSearch.exportResults`, `sfSearch.searchHistory`.
