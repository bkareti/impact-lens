# Changelog

All notable changes to **ImpactLens – Salesforce Dependency Analyzer** are documented here.

The format follows [Keep a Changelog](https://keepachangelog.com/en/1.0.0/) and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [3.1.0] – 2026-06-22

### 🛠️ Hardening — Accurate Search, Faster Lookups, Leaner Commands

#### ✨ Added

- **Precise-by-default matching** — searching `Account` now matches `Account` and `Account.Name` but **not** `AccountService`. Backed by a new precise tokenizer (whole identifier + dot/underscore segments, never camelCase). Shared tokenizers live in `src/indexing/tokenize.ts`.
- **Broad (contains) toggle** — opt-in substring matching in the search panel for when you want wider recall; mutually exclusive with Exact match.
- **`sfSearch.enableHover` setting** — toggle the hover impact summary independently from CodeLens (default `true`).
- **One-click Connected-Org enablement** — switching to Connected-Org mode without the Tooling API enabled now shows a friendly notice with an **Enable Connected-Org Search** button instead of a settings error.
- **Focused unit test suite** (Vitest) covering tokenization/matching precision and the file parser; `npm test` script added.
- **Large-project warning** — a one-time notice when file discovery hits the per-pattern cap, so an incomplete index is never silent.

#### ⚡ Performance

- **O(1)-style reference lookups** — search, impact analysis, CodeLens, and Hover now use derived exact/token indexes instead of scanning the entire reference graph on every query, hover, and keystroke. Large orgs feel dramatically snappier.
- **Debounced index persistence** — rapid file saves coalesce into a single write instead of repeatedly serializing the whole index to disk.

#### 🐛 Fixed

- **Impact analysis false positives** — removed bidirectional substring matching that produced spurious transitive dependencies and inflated risk scores.
- **Dropped references on the same line** — search and impact dedup keys now include column + keyword, so multiple distinct references on one line are all kept.
- **Blank Search Results tree rows for org results** — items now label from the component name (`fileName`) and fall back gracefully when there's no local file.
- **Misleading "no dependents" for org searches** — the Impact view now shows an informational notice (impact analysis applies to Local Project searches) instead of a false empty result.
- **Reliable sidebar wiring** — tree views update via a stable, panel-independent search event, and the search panel reliably auto-opens when the view is already visible at activation.
- **Hover gated by the wrong setting** — hover honored `enableCodeLens`; it now uses `enableHover`.
- **CLI detection** — `isCliAvailable()` re-probes on a TTL so installing the Salesforce CLI mid-session is detected.

#### 🔧 Changed

- **Commands consolidated 12 → 7** — `fieldUsage`, `objectUsage`, `searchFromEditor`, and `searchSelection` merged into **Search Selection or Word at Cursor**; `impactAnalysis` merged into **Analyze Impact**. Redundant `onCommand:*` activation events removed (activation via `workspaceContains`).
- **Index schema version bumped to 3** — triggers a one-time reindex on first launch after upgrade.

#### 🧹 Removed

- Dead code: unused `queryFieldDependencies` / `queryObjectDependencies` and the orphaned SOQL sanitizer, and unused `searchFieldUsage` / `searchObjectUsage`.
- Stale committed `.vsix` binaries and `debug-*.js` scripts; added an ESLint config so `npm run lint` works.

---

## [3.0.0] – 2026-03-30

### 🚀 Major — Multi-Hop Impact Analysis, Risk Scoring & New Providers

#### ✨ Added

- **Multi-hop impact traversal** — `ImpactAnalyzer.analyze()` now walks the reference graph to configurable depth (1-5 hops via `sfSearch.impactDepth`, default 3), discovering indirect/transitive dependencies.
- **Cycle detection** — visited set keyed on `filePath:line` prevents infinite loops; `hasCircularDeps` flag reported in `ImpactReport`.
- **Risk scoring (0-100)** — composite algorithm: reference count (max 30 pts) + file spread (max 25 pts) + depth (max 15 pts) + type-weighted severity (max 30 pts, test classes discounted at 0.3×). Mapped to `RiskLevel` enum: Low (0-24), Medium (25-49), High (50-74), Critical (75-100).
- **`RiskLevel` enum** — `Low | Medium | High | Critical` in `src/models/searchResult.ts`.
- **`ExportFormat` enum** — `csv | json | markdown` for export methods.
- **Impact export** — `ImpactAnalyzer.exportReport()` produces CSV, JSON, or Markdown; `sfSearch.exportImpact` command opens a QuickPick and creates an untitled document.
- **Search results export** — `SearchEngine.exportResults()` in CSV/JSON/Markdown; `sfSearch.exportResults` command.
- **Search history** — `SearchEngine.addToHistory()` / `getHistory()` / `clearHistory()`; `sfSearch.searchHistory` command shows a QuickPick of recent queries.
- **CodeLens provider** (`src/ui/codeLensProvider.ts`) — shows `$(references) N references` above Apex class/trigger/interface/enum declarations and LWC/Aura component files. Controlled by `sfSearch.enableCodeLens` (default `true`).
- **Hover provider** (`src/ui/hoverProvider.ts`) — hovering over a Salesforce API name shows a mini impact summary (reference count, file count, types) with clickable _Search_ and _Analyze Impact_ commands.
- **Visualforce parser** — dedicated `parseVisualforce()` in `fileParser.ts` with five new regex patterns: `VF_CONTROLLER`, `VF_EXTENSIONS`, `VF_INPUT_FIELD`, `VF_ACTION`, `VF_COMPONENT_REF`. Previously VF files were routed through the Aura parser.
- **6 new metadata types** — `ApprovalProcess`, `SharingRule`, `RecordType`, `QuickAction`, `GlobalValueSet`, `CustomSetting` added to `MetadataType` enum, `classifyFile()`, `SF_FILE_GLOBS`, `FILTER_GROUPS`, and `getMetadataIcon()`.
- **2 new filter groups** — `automation` (Flow + WorkflowRule + ApprovalProcess + SharingRule) and `ui` (Layout + FlexiPage + QuickAction + VisualforcePage + VisualforceComponent).
- **Deeper Flow XML extraction** — `FLOW_REF_TAGS` now captures `object`, `objectType`, `targetReference`, `assignToReference`, `processMetadataValues` in addition to `actionName`, `apexClass`, `flowName`.
- **Risk-level badge in Impact View** — summary item shows color-coded risk (green=Low, orange=Medium, red=High, error=Critical) with score in tooltip.
- **`ImpactViewProvider.getLastReport()`** — exposes the last `ImpactReport` for the export command.
- **`ResultsViewProvider.getResults()`** — exposes current search results for the export command.
- **5 new commands** — `sfSearch.analyzeImpact`, `sfSearch.exportImpact`, `sfSearch.exportResults`, `sfSearch.searchHistory`, registered in `package.json` and `extension.ts`.
- **3 new settings** — `sfSearch.impactDepth` (1-5, default 3), `sfSearch.orgQueryConcurrency` (1-8, default 3), `sfSearch.enableCodeLens` (default `true`).

#### 🔒 Security

- **`exec()` → `execFile()`** — `SalesforceService` now uses `execFile()` with string-array arguments throughout, eliminating shell injection vectors.
- **`sanitizeSoqlParam()`** — validates all user-supplied SOQL parameters against `[a-zA-Z0-9_.]`; rejects anything else.
- All CLI commands (`sf data query`, `sf version`) pass arguments as arrays, never interpolated into a shell string.

#### ⚡ Performance

- **Parallel org cache build** — `buildOrgCache()` now executes Tooling API queries in parallel batches (concurrency controlled by `sfSearch.orgQueryConcurrency`, default 3) instead of sequential queries.

#### 🔧 Changed

- `DependencyNode` extended with optional `riskLevel` and `depth` fields.
- `ImpactReport` extended with `riskLevel`, `riskScore`, `affectedFiles`, `hasCircularDeps`, `maxDepthReached`.
- `SearchHistoryEntry` extended with optional `filters` field.
- `FILTER_GROUPS.objects` now includes `CustomSetting`, `GlobalValueSet`, `RecordType`.
- `FILTER_GROUPS.metadata` now includes `CustomSetting`, `GlobalValueSet`, `RecordType`, `QuickAction`.
- `FILTER_GROUPS.validationRules` now includes `ApprovalProcess`.
- Impact analysis summary tooltip now shows risk level, score, affected file count, max depth, and circular dependency warning.

---

## [2.0.0] – 2026-03-20

### 🚀 Major — Org Search & Tooling API Integration

#### ✨ Added

- **Org search via Tooling API** — optional connected-org search querying 8 metadata types (ApexClass, ApexTrigger, VF Pages, VF Components, AuraDefinition, CustomLabel, ValidationRule, Flow) with `LIMIT 2000` each.
- **Org cache progress** — per-type progress bar in the webview during org cache build.
- **`SalesforceService`** — new service layer: CLI detection (`sf`/`sfdx`), Tooling API queries, field/object dependency queries.
- **`sfSearch.enableToolingApi` setting** — toggle for Tooling API integration (default `false`).
- **Search mode toggle** — webview supports switching between local and org search.
- **`refreshOrgCache` command** — explicit cache refresh button in webview.

#### 🔧 Changed

- `SearchPanel.createOrShow()` signature updated to accept `SalesforceService` parameter.
- Webview message protocol extended with `searchMode`, `orgCacheProgress`, `orgCacheRefreshed` messages.
- Version bumped from 1.1.0 to 2.0.0.

---

## [1.1.0] – 2026-03-16

### ✨ Added – Search Panel (Webview)

- **Filter presets** — one-click buttons to switch between _All_, _Source_ (Apex + LWC + Aura + Flows), _Metadata_ (Objects + Permissions + Labels), and _Clear Filters_ without ticking individual checkboxes.
- **Exact match toggle** — lock searches to whole-word/exact string mode; re-runs the current query instantly on toggle.
- **Summary pills** — live counters showing _Total_, _Visible_ (after table filter), displayed range, and an _Exact Mode_ badge when active.
- **Term highlighting** — matched query words and active table-filter text are highlighted with `<mark>` tags in both the file name and preview columns.
- **Per-row action buttons** — _Open_ (navigates to the exact line) and _Copy Path_ (copies the full file path to clipboard) appear on row hover.
- **Numbered pagination** — page buttons `‹ 1 … 4 5 6 … 20 ›` with First/Last navigation replace the old previous/next-only controls.
- **Jump-to-page** — type a page number and press _Go_ or `Enter` to jump directly.
- **State persistence** — query, page size, current page, sort column, sort direction, table filter, exact-match toggle, and all type-filter checkboxes are saved via `vscode.setState()` and restored when the panel is re-shown.
- **Keyboard shortcuts** — `/` focuses the search input from anywhere in the panel; `Escape` clears the active input.
- **Empty state illustrations** — distinct messages for _no query yet_, _loading_, and _no results found_, each with an icon for quick visual recognition.
- **Status bar text** — shows current mode (fuzzy/exact), active filter count, and loading spinner during searches.

### ✨ Added – Results Sidebar (TreeView)

- **Summary header row** — displays `N results for "query"` at the top of the tree so the result count is always visible without scrolling.
- **Groups sorted by match count** — metadata-type groups are ordered largest-first for faster scanning.
- **Color-coded icons** — every one of the 24 `MetadataType` variants now has a distinct `ThemeIcon` with a `ThemeColor` tint (blue = Apex, green = LWC, purple = Flow, red = Validation Rules, etc.).
- **Rich Markdown tooltips** — hovering a result item shows file name, line number, object name, relevance score, relative workspace path, and a code snippet preview.
- **Clean item labels** — file name only as the primary label; object name and line number moved to the VS Code `description` field for better readability.
- **Relevance-score sorting** — results within each group default to highest-score-first; `setSortKey()` API added for programmatic sort changes.
- **Accessibility labels** — `accessibilityInformation.label` set on every result item.
- **Friendly placeholder** — "Run a search to see results here" replaces the old "No results" text.
- **`getMetadataIcon` exported** — reusable by the impact view and any future provider.

### ✨ Added – Impact Analysis Sidebar (TreeView)

- **Summary header row** — displays `Impact: "name"` with total reference count as description.
- **Type-aware icons** — node icons are resolved from the node's `type` string through exact enum match then fuzzy keyword fallback (Apex, LWC, Aura, Flow, Object, Field, Permission, Profile, Layout, Validation).
- **Rich Markdown tooltips** — each node shows name, type, line, relative path, and snippet preview.
- **Smart child sorting** — children with further dependents appear first; ties broken by `referenceCount` descending.
- **Reference count + line in description** — shown as `×N  :line  N deps` rather than embedded in the label.
- **Root node file navigation** — clicking the root item opens its source file when `filePath` is available.
- **Accurate total reference count** — recursive `_countNodes()` replaces the old flat `referenceCount` used in the header.
- **Friendly placeholder** — "Run impact analysis to see dependencies" replaces "No impact analysis run".

### 🔧 Changed

- `SearchPanel.createOrShow()` is now a **2-argument factory** (`extensionUri`, `searchEngine`) — the `ImpactAnalyzer` parameter has been removed; the panel no longer hosts an impact tab.
- Search panel webview **impact tab removed** — impact analysis is exclusively a sidebar/command-palette feature, reducing UI surface and cognitive load.
- `getMetadataIcon()` in `resultsView.ts` changed from `private function` to **exported function** for reuse.
- Extension bundle size: **127 KB → 133 KB** (additional sidebar logic).

### 🐛 Fixed

- `escapeRegExp` regex inside esbuild template literal was causing `Unexpected "}"` parse error — fixed character class ordering.
- Group collapse state is now cleared on every new search (prevents stale collapsed groups from hiding fresh results).

---

## [1.0.0] – 2026-01-01

### 🎉 Initial Release

#### Search Panel (Webview)

- Full-text search across 17+ Salesforce metadata types: Apex Classes, Apex Triggers, LWC, Aura, Flows, Validation Rules, Workflow Rules, Custom Objects, Custom Fields, Custom Metadata, Permission Sets, Profiles, Layouts, Reports, Email Templates, Named Credentials, Platform Events, Visualforce Pages & Components, Custom Labels, Static Resources, FlexiPage.
- Type-filter checkboxes for each metadata category.
- Results table with columns: File, Type, Object, Line, Preview.
- Column sorting (click header to toggle asc/desc).
- Client-side table filter input for live result narrowing.
- Pagination with page-size selector (10 / 50 / 100 per page).
- Open-file-at-line integration via VS Code editor commands.

#### Impact Analysis (Webview tab — removed in 1.1.0)

- Launched impact analysis from the search panel's second tab.
- Summary card counts grouped by metadata type.
- Grouped file list with click-to-navigate.

#### Sidebar Tree Views

- **Search Results** tree in the ImpactLens Activity Bar panel — grouped by metadata type, expandable/collapsible.
- **Impact Analysis** tree — dependency tree rooted at the analyzed element with click-to-navigate on leaf nodes.

#### Indexing Engine

- Worker-thread parallel file parsing (`dist/indexWorker.js`).
- MiniSearch full-text index with custom camelCase/PascalCase/underscore tokenizer.
- Regex-based reference extraction for Apex (`.cls`, `.trigger`), JavaScript (`.js`), HTML (`.html`).
- XML parsing via `fast-xml-parser` for Flows, Objects, Permission Sets, Profiles, Layouts, Labels.
- Persistent index cache written to `context.globalStorageUri/search-index.json`.
- Incremental re-index on file save (FileSystemWatcher + mtime tracking + debounce).
- Configurable exclude patterns, max file size, and debounce delay.

#### Dual-Strategy Search

- Reference-graph lookup (precise, line-level) merged with MiniSearch full-text (recall) — deduplicated by `filePath:line`.
- Exact-match mode via MiniSearch `combineWith: 'AND'` and regex post-filter.
- Field-boosted ranking: file name ×2, references ×1.5, methods ×1.2.

#### Salesforce CLI Integration (optional)

- `sfSearch.enableToolingApi` setting enables enriched dependency data via Tooling API.
- Auto-detects `sf` / `sfdx` CLI availability; silently skips if not present.
- Package directories read from `sfdx-project.json`; falls back to `force-app`.

#### Commands registered

- `sfSearch.search` — Open Search Panel
- `sfSearch.impactAnalysis` — Impact Analysis (command palette / context menu)
- `sfSearch.fieldUsage` — Find Field Usage (editor context menu, requires selection)
- `sfSearch.objectUsage` — Find Object Usage (editor context menu, requires selection)
- `sfSearch.searchFromEditor` — Search word at cursor
- `sfSearch.searchSelection` — Search selected text
- `sfSearch.openResult` — Open file at line (used internally by tree views)
- `sfSearch.rebuildIndex` — Force full index rebuild

#### Extension Settings

- `sfSearch.excludePatterns` — glob patterns to skip during indexing
- `sfSearch.maxFileSize` — max file size to index (default 1 MB)
- `sfSearch.debounceDelay` — file-watcher debounce (default 300 ms)
- `sfSearch.enableToolingApi` — Tooling API toggle (default `false`)
- `sfSearch.fuzzyTolerance` — MiniSearch fuzziness (default `0.2`)

---

[3.0.0]: https://github.com/BabuKareti/sf-advanced-search/compare/v2.0.0...v3.0.0
[2.0.0]: https://github.com/BabuKareti/sf-advanced-search/compare/v1.1.0...v2.0.0
[1.1.0]: https://github.com/BabuKareti/sf-advanced-search/compare/v1.0.0...v1.1.0
[1.0.0]: https://github.com/BabuKareti/sf-advanced-search/releases/tag/v1.0.0
