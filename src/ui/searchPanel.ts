import * as vscode from 'vscode';
import { SearchEngine, SearchFilters } from '../search/searchEngine';
import { SearchResult } from '../models/searchResult';
import { SalesforceService, OrgSearchResult, OrgCacheProgressFn } from '../services/salesforceService';

/** Payload emitted after each search completes. */
export interface SearchEvent {
  query: string;
  results: SearchResult[];
}

/**
 * Manages the search webview panel.
 */
export class SearchPanel {
  public static currentPanel: SearchPanel | undefined;
  public static readonly viewType = 'sfSearch.searchPanel';

  private readonly panel: vscode.WebviewPanel;
  private readonly searchEngine: SearchEngine;
  private readonly sfService: SalesforceService;
  private readonly disposables: vscode.Disposable[] = [];

  /** Fires after every local search with the query and results. */
  private readonly _onDidSearch = new vscode.EventEmitter<SearchEvent>();
  public readonly onDidSearch = this._onDidSearch.event;

  public static createOrShow(
    extensionUri: vscode.Uri,
    searchEngine: SearchEngine,
    sfService: SalesforceService
  ): SearchPanel {
    const column = vscode.window.activeTextEditor
      ? vscode.window.activeTextEditor.viewColumn
      : undefined;

    if (SearchPanel.currentPanel) {
      SearchPanel.currentPanel.panel.reveal(column);
      return SearchPanel.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      SearchPanel.viewType,
      'ImpactLens',
      column || vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri],
      }
    );

    SearchPanel.currentPanel = new SearchPanel(panel, searchEngine, sfService);
    return SearchPanel.currentPanel;
  }

  private constructor(
    panel: vscode.WebviewPanel,
    searchEngine: SearchEngine,
    sfService: SalesforceService
  ) {
    this.panel = panel;
    this.searchEngine = searchEngine;
    this.sfService = sfService;

    this.panel.webview.html = this.getHtmlContent();

    this.panel.onDidDispose(() => this.dispose(), null, this.disposables);

    this.panel.webview.onDidReceiveMessage(
      async (message: {
        command: string;
        query?: string;
        filters?: SearchFilters;
        exactMatch?: boolean;
        searchMode?: string;
        filePath?: string;
        line?: number;
        text?: string;
      }) => {
        switch (message.command) {
          case 'search':
            if (message.query) {
              if (message.searchMode === 'org') {
                await this.handleOrgSearch(message.query);
              } else {
                await this.handleSearch(
                  message.query,
                  message.filters,
                  message.exactMatch ?? false
                );
              }
            }
            break;
          case 'refreshOrgCache':
            await this.handleRefreshOrgCache();
            break;
          case 'openFile':
            if (message.filePath) {
              await this.openFile(message.filePath, message.line ?? 1);
            }
            break;
          case 'copyText':
            if (message.text) {
              await vscode.env.clipboard.writeText(message.text);
            }
            break;
        }
      },
      null,
      this.disposables
    );
  }

  /**
   * Execute a search from the webview.
   */
  private async handleSearch(
    query: string,
    filters?: SearchFilters,
    exactMatch: boolean = false
  ): Promise<void> {
    if (!query) {
      return;
    }

    const results = this.searchEngine.search({
      query,
      filters,
      exactMatch,
      maxResults: 500,
    });

    this.panel.webview.postMessage({
      command: 'searchResults',
      results: results.map((result) => ({
        fileName: result.fileName,
        filePath: result.filePath,
        line: result.line,
        snippet: result.snippet,
        metadataType: result.metadataType,
        objectName: result.objectName,
        score: result.score,
      })),
      query,
      totalResults: results.length,
      exactMatch,
    });

    // Notify listeners (tree views) with the full results
    this._onDidSearch.fire({ query, results });
  }

  /**
   * Execute a connected-org search via Tooling API.
   * First call builds the org cache (with progress); subsequent calls are instant.
   */
  private async handleOrgSearch(query: string): Promise<void> {
    if (!query) {
      return;
    }

    try {
      // Progress callback → sends per-type progress to webview
      const onProgress: OrgCacheProgressFn = (stage, done, total) => {
        this.panel.webview.postMessage({
          command: 'orgCacheProgress',
          stage,
          done,
          total,
        });
      };

      const orgResults = await this.sfService.searchOrg(query, onProgress);

      const results = orgResults.map((r: OrgSearchResult, idx: number) => ({
        fileName: r.name,
        filePath: '',
        line: 0,
        snippet: r.snippet || `${r.type} — ${r.objectName || r.name}`,
        metadataType: r.type,
        objectName: r.objectName || '',
        score: r.score ?? (orgResults.length - idx),
      }));

      this.panel.webview.postMessage({
        command: 'searchResults',
        results,
        query,
        totalResults: results.length,
        exactMatch: false,
        searchMode: 'org',
        cacheSize: this.sfService.orgCacheSize,
      });
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Org search: ${message}`);
      this.panel.webview.postMessage({
        command: 'searchResults',
        results: [],
        query,
        totalResults: 0,
        exactMatch: false,
        searchMode: 'org',
        error: message,
      });
    }
  }

  /**
   * Force-refresh the org metadata cache.
   */
  private async handleRefreshOrgCache(): Promise<void> {
    try {
      const onProgress: OrgCacheProgressFn = (stage, done, total) => {
        this.panel.webview.postMessage({
          command: 'orgCacheProgress',
          stage,
          done,
          total,
        });
      };

      await this.sfService.refreshOrgCache(onProgress);

      this.panel.webview.postMessage({
        command: 'orgCacheRefreshed',
        cacheSize: this.sfService.orgCacheSize,
      });

      vscode.window.showInformationMessage(
        `ImpactLens: Org cache refreshed — ${this.sfService.orgCacheSize} components loaded.`
      );
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      vscode.window.showErrorMessage(`Failed to refresh org cache: ${message}`);
    }
  }

  /**
   * Open a file and position cursor at the given line.
   */
  private async openFile(filePath: string, line: number): Promise<void> {
    try {
      const uri = vscode.Uri.file(filePath);
      const document = await vscode.workspace.openTextDocument(uri);
      const editor = await vscode.window.showTextDocument(document, {
        preview: true,
        viewColumn: vscode.ViewColumn.One,
      });
      const position = new vscode.Position(Math.max(0, line - 1), 0);
      editor.selection = new vscode.Selection(position, position);
      editor.revealRange(
        new vscode.Range(position, position),
        vscode.TextEditorRevealType.InCenter
      );
    } catch {
      vscode.window.showErrorMessage(`Failed to open file: ${filePath}`);
    }
  }

  /**
   * Trigger a search programmatically.
   */
  public triggerSearch(query: string): void {
    this.panel.webview.postMessage({
      command: 'setQuery',
      query,
    });
    void this.handleSearch(query);
  }

  private dispose(): void {
    SearchPanel.currentPanel = undefined;
    this._onDidSearch.dispose();
    this.panel.dispose();
    while (this.disposables.length) {
      const disposable = this.disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }

  /**
   * Returns the full HTML content for the search panel webview.
   */
  private getHtmlContent(): string {
    const nonce = getNonce();

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <meta http-equiv="Content-Security-Policy"
    content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}';" />
  <title>ImpactLens</title>
  <style>
    :root {
      --bg: var(--vscode-editor-background);
      --bg-elevated: var(--vscode-editorWidget-background);
      --fg: var(--vscode-editor-foreground);
      --muted: var(--vscode-descriptionForeground);
      --input-bg: var(--vscode-input-background);
      --input-border: var(--vscode-input-border);
      --input-fg: var(--vscode-input-foreground);
      --btn-bg: var(--vscode-button-background);
      --btn-fg: var(--vscode-button-foreground);
      --btn-hover: var(--vscode-button-hoverBackground);
      --secondary-btn-bg: var(--vscode-button-secondaryBackground);
      --secondary-btn-fg: var(--vscode-button-secondaryForeground);
      --secondary-btn-hover: var(--vscode-button-secondaryHoverBackground);
      --border: var(--vscode-panel-border);
      --highlight: var(--vscode-editor-findMatchHighlightBackground);
      --highlight-strong: var(--vscode-editor-findMatchBackground);
      --badge-bg: var(--vscode-badge-background);
      --badge-fg: var(--vscode-badge-foreground);
      --link: var(--vscode-textLink-foreground);
      --success: var(--vscode-testing-iconPassed);
      --table-row: color-mix(in srgb, var(--bg) 92%, white 8%);
    }

    * { box-sizing: border-box; margin: 0; padding: 0; }

    body {
      font-family: var(--vscode-font-family, 'Segoe UI', Tahoma, Geneva, sans-serif);
      font-size: var(--vscode-font-size, 13px);
      color: var(--fg);
      background: var(--bg);
      padding: 16px;
    }

    .panel-shell {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .search-bar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 8px;
      align-items: center;
    }

    .search-bar input,
    .results-toolbar input,
    .results-toolbar select,
    .jump-input {
      padding: 7px 10px;
      background: var(--input-bg);
      border: 1px solid var(--input-border);
      color: var(--input-fg);
      border-radius: 6px;
      font-size: inherit;
    }

    .search-bar input:focus,
    .results-toolbar input:focus,
    .results-toolbar select:focus,
    .jump-input:focus {
      outline: 1px solid var(--btn-bg);
    }

    button {
      padding: 7px 14px;
      background: var(--btn-bg);
      color: var(--btn-fg);
      border: none;
      border-radius: 6px;
      cursor: pointer;
      font-size: inherit;
      line-height: 1.2;
    }

    button:hover { background: var(--btn-hover); }

    button.secondary {
      background: var(--secondary-btn-bg);
      color: var(--secondary-btn-fg);
    }

    button.secondary:hover {
      background: var(--secondary-btn-hover);
    }

    button.ghost {
      background: transparent;
      border: 1px solid var(--border);
      color: var(--fg);
    }

    button.ghost:hover {
      background: var(--bg-elevated);
    }

    button:disabled {
      opacity: 0.45;
      cursor: not-allowed;
    }

    .controls-card,
    .results-card {
      border: 1px solid var(--border);
      border-radius: 10px;
      background: var(--bg-elevated);
      padding: 12px;
      position: relative;
    }

    .controls-grid {
      display: flex;
      flex-direction: column;
      gap: 12px;
    }

    .option-row,
    .filters-row,
    .summary-row,
    .results-toolbar {
      display: flex;
      gap: 8px;
      align-items: center;
      justify-content: space-between;
      flex-wrap: wrap;
    }

    .option-row-left,
    .option-row-right,
    .filters-row-left,
    .filters-row-right,
    .results-toolbar-left,
    .results-toolbar-right,
    .pagination-actions,
    .pagination-pages {
      display: flex;
      gap: 8px;
      align-items: center;
      flex-wrap: wrap;
    }

    .toggle-label,
    .filter-chip {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      cursor: pointer;
    }

    .toggle-label {
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--bg);
    }

    .toggle-label input,
    .filter-chip input {
      cursor: pointer;
    }

    .quick-hint,
    .muted {
      color: var(--muted);
      font-size: 0.9em;
    }

    .filter-chip {
      padding: 6px 10px;
      border: 1px solid var(--border);
      border-radius: 999px;
      background: var(--bg);
      white-space: nowrap;
    }

    .summary-pills {
      display: flex;
      gap: 8px;
      flex-wrap: wrap;
    }

    .summary-pill {
      display: inline-flex;
      align-items: center;
      gap: 6px;
      padding: 6px 10px;
      border-radius: 999px;
      background: var(--bg);
      border: 1px solid var(--border);
    }

    .summary-pill strong {
      font-weight: 600;
    }

    .status {
      font-size: 0.95em;
      color: var(--muted);
    }

    .status.loading {
      color: var(--link);
    }

    .status.loading::before {
      content: '';
      display: inline-block;
      width: 12px;
      height: 12px;
      margin-right: 6px;
      border: 2px solid var(--border);
      border-top-color: var(--link);
      border-radius: 50%;
      animation: spin 0.6s linear infinite;
      vertical-align: middle;
    }

    @keyframes spin { to { transform: rotate(360deg); } }

    /* Loading overlay */
    .loading-overlay {
      display: none;
      position: absolute;
      inset: 0;
      background: color-mix(in srgb, var(--bg) 85%, transparent 15%);
      z-index: 100;
      align-items: center;
      justify-content: center;
      flex-direction: column;
      gap: 16px;
      border-radius: 10px;
    }

    .loading-overlay.active {
      display: flex;
    }

    .spinner {
      width: 36px;
      height: 36px;
      border: 3px solid var(--border);
      border-top-color: var(--link);
      border-radius: 50%;
      animation: spin 0.7s linear infinite;
    }

    .loading-text {
      font-size: 0.95em;
      color: var(--fg);
      text-align: center;
    }

    .loading-sub {
      font-size: 0.85em;
      color: var(--muted);
    }

    .progress-bar-container {
      width: 220px;
      height: 4px;
      background: var(--border);
      border-radius: 4px;
      overflow: hidden;
    }

    .progress-bar-fill {
      height: 100%;
      background: var(--link);
      border-radius: 4px;
      transition: width 0.3s ease;
      width: 0%;
    }

    /* Org cache badge */
    .cache-badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 3px 8px;
      border-radius: 999px;
      background: color-mix(in srgb, var(--success) 15%, transparent 85%);
      color: var(--success);
      font-size: 0.82em;
      white-space: nowrap;
    }

    .results-toolbar label {
      font-size: 0.92em;
      color: var(--muted);
    }

    .results-container {
      max-height: 64vh;
      overflow: auto;
      border: 1px solid var(--border);
      border-radius: 8px;
    }

    table {
      width: 100%;
      border-collapse: collapse;
    }

    th, td {
      text-align: left;
      padding: 8px 10px;
      border-bottom: 1px solid var(--border);
      vertical-align: top;
    }

    th {
      font-weight: 600;
      position: sticky;
      top: 0;
      background: var(--bg-elevated);
      cursor: pointer;
      user-select: none;
      z-index: 1;
    }

    th.sort-active {
      color: var(--link);
    }

    tbody tr:nth-child(even) {
      background: var(--table-row);
    }

    tbody tr:hover {
      background: var(--highlight);
    }

    td.file-cell,
    td.object-cell,
    td.snippet {
      white-space: normal;
    }

    td.file-cell a {
      color: var(--link);
      cursor: pointer;
      text-decoration: none;
      font-weight: 500;
    }

    td.file-cell a:hover {
      text-decoration: underline;
    }

    [data-action] {
      cursor: pointer;
    }

    .file-path,
    .line-meta {
      display: none;
    }

    td.snippet {
      font-family: var(--vscode-editor-font-family, monospace);
      font-size: 0.9em;
      max-width: 560px;
      line-height: 1.45;
    }

    .badge {
      display: inline-block;
      padding: 2px 8px;
      border-radius: 999px;
      background: var(--badge-bg);
      color: var(--badge-fg);
      font-size: 0.85em;
      white-space: nowrap;
    }

    .action-buttons {
      display: flex;
      gap: 4px;
      flex-wrap: nowrap;
    }

    .action-buttons button {
      padding: 4px 8px;
      font-size: 0.85em;
    }

    mark {
      background: var(--highlight-strong);
      color: inherit;
      border-radius: 3px;
      padding: 0 1px;
    }

    .pagination {
      display: flex;
      align-items: center;
      justify-content: space-between;
      gap: 10px;
      margin-top: 12px;
      flex-wrap: wrap;
    }

    .pagination-page {
      min-width: 34px;
      padding: 6px 10px;
    }

    .pagination-page.active {
      background: var(--link);
      color: var(--btn-fg);
    }

    .pagination-ellipsis {
      color: var(--muted);
      padding: 0 2px;
    }

    .jump-input {
      width: 72px;
    }

    .empty-state {
      text-align: center;
      padding: 52px 24px;
      color: var(--muted);
    }

    .empty-state-title {
      font-size: 1.15em;
      color: var(--fg);
      margin-bottom: 8px;
    }

    .search-mode-row {
      display: flex;
      gap: 0;
      border-radius: 6px;
      border: 1px solid var(--border);
      overflow: hidden;
      width: fit-content;
    }

    .search-mode-row button {
      border-radius: 0;
      border: none;
      padding: 7px 16px;
      background: var(--bg);
      color: var(--fg);
      font-weight: 400;
      cursor: pointer;
    }

    .search-mode-row button:hover {
      background: var(--bg-elevated);
    }

    .search-mode-row button.active {
      background: var(--btn-bg);
      color: var(--btn-fg);
      font-weight: 600;
    }

    .search-mode-row button.active:hover {
      background: var(--btn-hover);
    }

    .org-notice {
      padding: 8px 12px;
      border-radius: 6px;
      background: color-mix(in srgb, var(--badge-bg) 20%, transparent 80%);
      font-size: 0.92em;
      color: var(--muted);
    }

    @media (max-width: 900px) {
      .search-bar {
        grid-template-columns: 1fr;
      }

      .results-toolbar,
      .option-row,
      .filters-row,
      .summary-row,
      .pagination {
        align-items: stretch;
      }

      .option-row-left,
      .option-row-right,
      .filters-row-left,
      .filters-row-right,
      .results-toolbar-left,
      .results-toolbar-right,
      .pagination-actions {
        width: 100%;
      }
    }
  </style>
</head>
<body>
  <div class="panel-shell">
    <div class="controls-card">
      <div class="controls-grid">
        <div class="search-bar">
          <input type="text" id="searchInput" placeholder="Search Salesforce metadata, fields, classes, or objects…" />
          <button id="searchButton">Search</button>
          <button id="clearSearchButton" class="secondary">Clear</button>
        </div>

        <div class="option-row">
          <div class="option-row-left">
            <div class="search-mode-row">
              <button id="modeLocal" class="active" data-mode="local">📁 Local Project</button>
              <button id="modeOrg" data-mode="org">☁️ Connected Org</button>
            </div>
            <button id="refreshOrgCacheButton" class="ghost" style="display:none;" title="Re-download all org metadata">🔄 Refresh Cache</button>
            <span id="cacheBadge" class="cache-badge" style="display:none;"></span>
            <label class="toggle-label">
              <input type="checkbox" id="exactMatchToggle" />
              <span>Exact match</span>
            </label>
            <span class="quick-hint">Press <strong>/</strong> to focus search</span>
          </div>
          <div class="option-row-right">
            <button id="selectAllFiltersButton" class="ghost">All Filters</button>
            <button id="sourceFiltersButton" class="ghost">Source</button>
            <button id="metadataFiltersButton" class="ghost">Metadata</button>
          </div>
        </div>

        <div id="orgNotice" class="org-notice" style="display:none;">⚡ Connected Org mode caches all metadata from your default org on first search, then searches instantly in-memory — Apex classes, triggers, Visualforce, Aura, LWC, custom labels, validation rules, and flows. Use <strong>Refresh Cache</strong> to re-download. Requires <code>sf org login web</code> and a default target-org set.</div>

        <div class="filters-row" id="filtersRow">
          <div class="filters-row-left filters">
            <label class="filter-chip"><input type="checkbox" class="filter-cb" data-filter="apex" /> Apex</label>
            <label class="filter-chip"><input type="checkbox" class="filter-cb" data-filter="lwc" /> LWC</label>
            <label class="filter-chip"><input type="checkbox" class="filter-cb" data-filter="aura" /> Aura</label>
            <label class="filter-chip"><input type="checkbox" class="filter-cb" data-filter="flows" /> Flows</label>
            <label class="filter-chip"><input type="checkbox" class="filter-cb" data-filter="objects" /> Objects</label>
            <label class="filter-chip"><input type="checkbox" class="filter-cb" data-filter="validationRules" /> Validation Rules</label>
            <label class="filter-chip"><input type="checkbox" class="filter-cb" data-filter="permissions" /> Permissions</label>
            <label class="filter-chip"><input type="checkbox" class="filter-cb" data-filter="profiles" /> Profiles</label>
            <label class="filter-chip"><input type="checkbox" class="filter-cb" data-filter="layouts" /> Layouts</label>
            <label class="filter-chip"><input type="checkbox" class="filter-cb" data-filter="labels" /> Labels</label>
            <label class="filter-chip"><input type="checkbox" class="filter-cb" data-filter="metadata" /> Custom Metadata</label>
          </div>
          <div class="filters-row-right">
            <button id="clearFiltersButton" class="ghost">Clear Filters</button>
          </div>
        </div>

        <div class="summary-row">
          <div class="summary-pills" id="summaryPills">
            <span class="summary-pill"><strong>0</strong><span>Results</span></span>
          </div>
          <div id="searchStatus" class="status">Ready</div>
        </div>
      </div>
    </div>

    <div class="results-card">
      <div class="loading-overlay" id="loadingOverlay">
        <div class="spinner"></div>
        <div class="loading-text" id="loadingText">Searching…</div>
        <div class="progress-bar-container" id="progressBarContainer" style="display:none;">
          <div class="progress-bar-fill" id="progressBarFill"></div>
        </div>
        <div class="loading-sub" id="loadingSub"></div>
      </div>
      <div class="results-toolbar">
        <div class="results-toolbar-left">
          <input type="text" id="resultsFilterInput" placeholder="Filter current results table…" />
          <button id="resetTableButton" class="secondary">Reset Table</button>
        </div>
        <div class="results-toolbar-right">
          <label for="pageSizeSelect">Page size</label>
          <select id="pageSizeSelect">
            <option value="10">10</option>
            <option value="50">50</option>
            <option value="100">100</option>
          </select>
          <label for="jumpToPageInput">Jump to page</label>
          <input type="number" min="1" id="jumpToPageInput" class="jump-input" placeholder="#" />
          <button id="jumpToPageButton" class="ghost">Go</button>
        </div>
      </div>

      <div class="results-container">
        <div id="searchResults">
          <div class="empty-state">
            <div class="empty-state-title">Search your Salesforce project</div>
            <p>Search fields, objects, Apex, LWC, and related metadata with sorting, filters, and pagination.</p>
          </div>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    let debounceTimer;
    const persistedState = vscode.getState() || {};
    const defaultFilters = {
      apex: true,
      lwc: true,
      aura: true,
      flows: true,
      objects: true,
      validationRules: true,
      permissions: true,
      permissionSets: true,
      profiles: true,
      layouts: true,
      labels: true,
      metadata: true,
    };

    const searchState = {
      query: persistedState.query || '',
      allResults: [],
      filteredResults: [],
      pageSize: persistedState.pageSize || 10,
      currentPage: persistedState.currentPage || 1,
      sortKey: persistedState.sortKey || 'score',
      sortDirection: persistedState.sortDirection || 'desc',
      tableFilter: persistedState.tableFilter || '',
      exactMatch: persistedState.exactMatch || false,
      searchMode: persistedState.searchMode || 'local',
      filters: Object.assign({}, defaultFilters, persistedState.filters || {}),
      isLoading: false,
      lastResultCount: 0,
      orgCacheSize: 0,
    };

    function persistUiState() {
      vscode.setState({
        query: searchState.query,
        pageSize: searchState.pageSize,
        currentPage: searchState.currentPage,
        sortKey: searchState.sortKey,
        sortDirection: searchState.sortDirection,
        tableFilter: searchState.tableFilter,
        exactMatch: searchState.exactMatch,
        searchMode: searchState.searchMode,
        filters: searchState.filters,
      });
    }

    // ── Loading overlay helpers ────────────────────────────────

    function showLoading(text, sub) {
      document.getElementById('loadingText').textContent = text || 'Searching…';
      document.getElementById('loadingSub').textContent = sub || '';
      document.getElementById('progressBarContainer').style.display = 'none';
      document.getElementById('loadingOverlay').classList.add('active');
    }

    function showLoadingProgress(text, done, total) {
      document.getElementById('loadingText').textContent = text || 'Loading…';
      const pct = total > 0 ? Math.round((done / total) * 100) : 0;
      document.getElementById('loadingSub').textContent = done + ' / ' + total + ' metadata types (' + pct + '%)';
      document.getElementById('progressBarContainer').style.display = 'block';
      document.getElementById('progressBarFill').style.width = pct + '%';
      document.getElementById('loadingOverlay').classList.add('active');
    }

    function hideLoading() {
      document.getElementById('loadingOverlay').classList.remove('active');
    }

    function updateCacheBadge(size) {
      const badge = document.getElementById('cacheBadge');
      if (size > 0) {
        badge.textContent = '✓ ' + size + ' cached';
        badge.style.display = 'inline-flex';
      } else {
        badge.style.display = 'none';
      }
    }

    function syncFilterCheckboxes() {
      document.querySelectorAll('.filter-cb').forEach((checkbox) => {
        checkbox.checked = Boolean(searchState.filters[checkbox.dataset.filter]);
      });
    }

    function getFiltersFromUi() {
      const filters = {};
      document.querySelectorAll('.filter-cb').forEach((checkbox) => {
        filters[checkbox.dataset.filter] = checkbox.checked;
      });
      return filters;
    }

    function syncFiltersFromUi(shouldSearch) {
      searchState.filters = getFiltersFromUi();
      persistUiState();
      if (shouldSearch && searchState.query) {
        doSearch();
      }
    }

    function setFilterPreset(preset) {
      if (preset === 'all') {
        searchState.filters = Object.assign({}, defaultFilters);
      } else if (preset === 'source') {
        searchState.filters = {
          apex: true,
          lwc: true,
          aura: true,
          flows: true,
          objects: false,
          validationRules: false,
          permissions: false,
          permissionSets: false,
          profiles: false,
          layouts: false,
          labels: false,
          metadata: false,
        };
      } else if (preset === 'metadata') {
        searchState.filters = {
          apex: false,
          lwc: false,
          aura: false,
          flows: false,
          objects: true,
          validationRules: true,
          permissions: true,
          permissionSets: true,
          profiles: true,
          layouts: true,
          labels: true,
          metadata: true,
        };
      } else if (preset === 'none') {
        searchState.filters = {
          apex: false,
          lwc: false,
          aura: false,
          flows: false,
          objects: false,
          validationRules: false,
          permissions: false,
          permissionSets: false,
          profiles: false,
          layouts: false,
          labels: false,
          metadata: false,
        };
      }

      syncFilterCheckboxes();
      persistUiState();
      if (searchState.query) {
        doSearch();
      }
    }

    function setSearchMode(mode) {
      searchState.searchMode = mode;
      document.getElementById('modeLocal').classList.toggle('active', mode === 'local');
      document.getElementById('modeOrg').classList.toggle('active', mode === 'org');
      document.getElementById('orgNotice').style.display = mode === 'org' ? 'block' : 'none';
      document.getElementById('filtersRow').style.display = mode === 'org' ? 'none' : 'flex';
      document.getElementById('refreshOrgCacheButton').style.display = mode === 'org' ? 'inline-flex' : 'none';
      document.getElementById('cacheBadge').style.display = mode === 'org' && searchState.orgCacheSize ? 'inline-flex' : 'none';
      persistUiState();
      renderStatus();
      if (searchState.query) {
        doSearch();
      }
    }

    function doSearch() {
      const query = document.getElementById('searchInput').value.trim();
      if (!query) {
        clearSearchResultsOnly();
        return;
      }

      searchState.query = query;
      searchState.filters = getFiltersFromUi();
      searchState.exactMatch = document.getElementById('exactMatchToggle').checked;
      searchState.isLoading = true;
      persistUiState();
      renderStatus();

      if (searchState.searchMode === 'org') {
        showLoading('Searching connected org…', 'First search loads metadata cache');
      } else {
        showLoading('Searching local workspace…');
      }

      vscode.postMessage({
        command: 'search',
        query,
        filters: searchState.filters,
        exactMatch: searchState.exactMatch,
        searchMode: searchState.searchMode,
      });
    }

    function clearSearchResultsOnly() {
      searchState.query = '';
      searchState.allResults = [];
      searchState.filteredResults = [];
      searchState.currentPage = 1;
      searchState.isLoading = false;
      persistUiState();
      renderStatus();
      renderSummaryPills();
      renderEmptyState(
        'Search your Salesforce project',
        'Search fields, objects, Apex, LWC, and related metadata with sorting, filters, and pagination.'
      );
    }

    function clearSearch() {
      document.getElementById('searchInput').value = '';
      clearSearchResultsOnly();
    }

    function openFile(filePath, line) {
      vscode.postMessage({ command: 'openFile', filePath, line });
    }

    function copyText(text) {
      vscode.postMessage({ command: 'copyText', text });
    }

    function updatePageSize(value) {
      searchState.pageSize = Number(value) || 10;
      searchState.currentPage = 1;
      persistUiState();
      renderCurrentResults();
    }

    function updateTableFilter(value) {
      searchState.tableFilter = value.trim().toLowerCase();
      searchState.currentPage = 1;
      persistUiState();
      renderCurrentResults();
    }

    function resetTableState() {
      searchState.tableFilter = '';
      searchState.pageSize = 10;
      searchState.currentPage = 1;
      searchState.sortKey = 'score';
      searchState.sortDirection = 'desc';
      document.getElementById('resultsFilterInput').value = '';
      document.getElementById('pageSizeSelect').value = '10';
      document.getElementById('jumpToPageInput').value = '';
      persistUiState();
      renderCurrentResults();
    }

    function jumpToPage() {
      const raw = document.getElementById('jumpToPageInput').value;
      const page = Number(raw);
      if (!Number.isFinite(page)) {
        return;
      }
      changePage(page);
    }

    function changePage(nextPage) {
      const totalPages = Math.max(1, Math.ceil(searchState.filteredResults.length / searchState.pageSize));
      searchState.currentPage = Math.max(1, Math.min(nextPage, totalPages));
      persistUiState();
      renderCurrentResults();
    }

    function setSort(sortKey) {
      if (searchState.sortKey === sortKey) {
        searchState.sortDirection = searchState.sortDirection === 'asc' ? 'desc' : 'asc';
      } else {
        searchState.sortKey = sortKey;
        searchState.sortDirection = sortKey === 'line' || sortKey === 'score' ? 'desc' : 'asc';
      }

      persistUiState();
      renderCurrentResults();
    }

    function buildPageList(totalPages, currentPage) {
      if (totalPages <= 7) {
        return Array.from({ length: totalPages }, (_, index) => index + 1);
      }

      const pages = new Set([1, totalPages, currentPage, currentPage - 1, currentPage + 1]);
      return Array.from(pages)
        .filter((page) => page >= 1 && page <= totalPages)
        .sort((left, right) => left - right);
    }

    function renderPaginationPages(totalPages) {
      const pages = buildPageList(totalPages, searchState.currentPage);
      let html = '';

      pages.forEach((pageNumber, index) => {
        const previous = pages[index - 1];
        if (index > 0 && previous && pageNumber - previous > 1) {
          html += '<span class="pagination-ellipsis">…</span>';
        }

        html += '<button class="pagination-page ' + (pageNumber === searchState.currentPage ? 'active' : '') + '" '
          + (pageNumber === searchState.currentPage ? 'disabled ' : '')
          + 'data-action="changePage" data-page="' + pageNumber + '">' + pageNumber + '</button>';
      });

      return html;
    }

    function renderStatus() {
      const statusElement = document.getElementById('searchStatus');
      statusElement.className = 'status' + (searchState.isLoading ? ' loading' : '');

      const modeLabel = searchState.searchMode === 'org' ? 'Connected Org' : 'Local';

      if (searchState.isLoading) {
        statusElement.textContent = searchState.searchMode === 'org'
          ? 'Searching org code bodies via Tooling API…'
          : 'Searching local workspace…';
        return;
      }

      if (!searchState.query) {
        statusElement.textContent = modeLabel + ' • Ready';
        return;
      }

      const mode = searchState.exactMatch ? 'Exact' : 'Smart';
      const filterCount = Object.values(searchState.filters).filter(Boolean).length;
      statusElement.textContent = modeLabel + ' • ' + mode + ' search • ' + filterCount + ' filter' + (filterCount === 1 ? '' : 's') + ' enabled';
    }

    function renderSummaryPills(totalResults, visibleResults, startIndex, endIndex) {
      const pills = [];
      pills.push('<span class="summary-pill"><strong>' + (totalResults || 0) + '</strong><span>Total</span></span>');
      pills.push('<span class="summary-pill"><strong>' + (visibleResults || 0) + '</strong><span>Visible</span></span>');

      if (totalResults) {
        pills.push('<span class="summary-pill"><strong>' + startIndex + '-' + endIndex + '</strong><span>Shown</span></span>');
      }

      if (searchState.exactMatch) {
        pills.push('<span class="summary-pill"><strong>Exact</strong><span>Mode</span></span>');
      }

      document.getElementById('summaryPills').innerHTML = pills.join('');
    }

    function getSortIndicator(sortKey) {
      if (searchState.sortKey !== sortKey) {
        return '';
      }

      return searchState.sortDirection === 'asc' ? ' ▲' : ' ▼';
    }

    function getComparableValue(result, sortKey) {
      if (sortKey === 'line') {
        return Number(result.line || 0);
      }

      if (sortKey === 'score') {
        return Number(result.score || 0);
      }

      return String(result[sortKey] || '').toLowerCase();
    }

    function applyResultsFilter(results) {
      if (!searchState.tableFilter) {
        return results.slice();
      }

      return results.filter((result) => {
        const haystack = [
          result.fileName,
          result.filePath,
          result.metadataType,
          result.objectName,
          result.snippet,
          String(result.line ?? ''),
        ]
          .join(' ')
          .toLowerCase();

        return haystack.includes(searchState.tableFilter);
      });
    }

    function sortResults(results) {
      const direction = searchState.sortDirection === 'asc' ? 1 : -1;
      return results.slice().sort((left, right) => {
        const leftValue = getComparableValue(left, searchState.sortKey);
        const rightValue = getComparableValue(right, searchState.sortKey);

        if (leftValue < rightValue) {
          return -1 * direction;
        }

        if (leftValue > rightValue) {
          return 1 * direction;
        }

        return 0;
      });
    }

    function escapeHtml(value) {
      const div = document.createElement('div');
      div.textContent = value || '';
      return div.innerHTML;
    }

    function escapeAttr(value) {
      return escapeHtml(value).replace(/"/g, '&quot;').replace(/'/g, '&#39;');
    }

    function escapeRegExp(value) {
      return value.replace(/[-/\\^$*+?.()|[\]{}]/g, '\\$&');
    }

    function getHighlightTerms() {
      const terms = [];
      if (searchState.query) {
        terms.push(searchState.query);
      }
      if (searchState.tableFilter) {
        searchState.tableFilter.split(/\s+/).filter(Boolean).forEach((term) => terms.push(term));
      }
      return Array.from(new Set(terms.filter(Boolean)));
    }

    function highlightText(value) {
      const base = String(value || '');
      if (!base) {
        return '';
      }

      let html = escapeHtml(base);
      const terms = getHighlightTerms().sort((left, right) => right.length - left.length);
      for (const term of terms) {
        const regex = new RegExp('(' + escapeRegExp(term) + ')', 'gi');
        html = html.replace(regex, '<mark>$1</mark>');
      }
      return html;
    }

    function renderEmptyState(title, message) {
      document.getElementById('searchResults').innerHTML =
        '<div class="empty-state">'
        + '<div class="empty-state-title">' + escapeHtml(title) + '</div>'
        + '<p>' + escapeHtml(message) + '</p>'
        + '</div>';
    }

    function renderCurrentResults() {
      const filteredResults = sortResults(applyResultsFilter(searchState.allResults));
      searchState.filteredResults = filteredResults;

      const totalResults = searchState.allResults.length;
      const visibleResults = filteredResults.length;
      const totalPages = Math.max(1, Math.ceil(visibleResults / searchState.pageSize));

      if (searchState.currentPage > totalPages) {
        searchState.currentPage = totalPages;
      }

      const startIndex = totalResults ? ((searchState.currentPage - 1) * searchState.pageSize) + 1 : 0;
      const endIndex = totalResults
        ? Math.min(startIndex + searchState.pageSize - 1, visibleResults)
        : 0;

      persistUiState();
      renderStatus();
      renderSummaryPills(totalResults, visibleResults, startIndex, endIndex);

      if (!totalResults) {
        renderEmptyState(
          'No results yet',
          searchState.query
            ? 'No matches found for "' + searchState.query + '". Try broader filters or disable exact match.'
            : 'Search fields, objects, Apex, LWC, and related metadata with sorting, filters, and pagination.'
        );
        return;
      }

      if (!visibleResults) {
        renderEmptyState(
          'No visible rows',
          'The current table filter removed all rows. Clear the table filter or reset the table.'
        );
        return;
      }

      const pageResults = filteredResults.slice(
        (searchState.currentPage - 1) * searchState.pageSize,
        (searchState.currentPage - 1) * searchState.pageSize + searchState.pageSize
      );

      let html = '<table><thead><tr>'
        + '<th class="' + (searchState.sortKey === 'fileName' ? 'sort-active' : '') + '" data-action="setSort" data-key="fileName">File' + getSortIndicator('fileName') + '</th>'
        + '<th class="' + (searchState.sortKey === 'metadataType' ? 'sort-active' : '') + '" data-action="setSort" data-key="metadataType">Type' + getSortIndicator('metadataType') + '</th>'
        + '<th class="' + (searchState.sortKey === 'objectName' ? 'sort-active' : '') + '" data-action="setSort" data-key="objectName">Object' + getSortIndicator('objectName') + '</th>'
        + '<th class="' + (searchState.sortKey === 'line' ? 'sort-active' : '') + '" data-action="setSort" data-key="line">Line' + getSortIndicator('line') + '</th>'
        + '<th class="' + (searchState.sortKey === 'snippet' ? 'sort-active' : '') + '" data-action="setSort" data-key="snippet">Preview' + getSortIndicator('snippet') + '</th>'
        + '</tr></thead><tbody>';

      for (const result of pageResults) {
        const line = result.line > 0 ? result.line : 1;
        const lineLabel = result.line > 0 ? String(result.line) : '—';
        const snippetText = result.snippet || (searchState.searchMode === 'org' ? 'Org dependency' : 'MiniSearch-only match');
        const hasFile = Boolean(result.filePath);

        html += '<tr>'
          + '<td class="file-cell">';

        if (hasFile) {
          html += '<a data-action="openFile" data-file="' + escapeAttr(result.filePath) + '" data-line="' + line + '" title="' + escapeAttr(result.filePath) + '">' + highlightText(result.fileName) + '</a>';
        } else {
          html += '<strong title="' + escapeAttr(searchState.searchMode === 'org' ? 'Connected Org' : '') + '">' + highlightText(result.fileName) + '</strong>';
        }

        html += '</td>'
          + '<td><span class="badge">' + escapeHtml(result.metadataType) + '</span></td>'
          + '<td class="object-cell">' + highlightText(result.objectName || '—') + '</td>'
          + '<td>' + escapeHtml(lineLabel) + '</td>'
          + '<td class="snippet">' + highlightText(snippetText.substring(0, 220)) + '</td>'
          + '</tr>';
      }

      html += '</tbody></table>';
      html += '<div class="pagination">'
        + '<span class="muted">Page ' + searchState.currentPage + ' of ' + totalPages + '</span>'
        + '<div class="pagination-actions">'
        + '<button class="ghost" ' + (searchState.currentPage === 1 ? 'disabled' : '') + ' data-action="changePage" data-page="1">First</button>'
        + '<button class="ghost" ' + (searchState.currentPage === 1 ? 'disabled' : '') + ' data-action="changePage" data-page="' + (searchState.currentPage - 1) + '">Previous</button>'
        + '<div class="pagination-pages">' + renderPaginationPages(totalPages) + '</div>'
        + '<button class="ghost" ' + (searchState.currentPage >= totalPages ? 'disabled' : '') + ' data-action="changePage" data-page="' + (searchState.currentPage + 1) + '">Next</button>'
        + '<button class="ghost" ' + (searchState.currentPage >= totalPages ? 'disabled' : '') + ' data-action="changePage" data-page="' + totalPages + '">Last</button>'
        + '</div>'
        + '</div>';

      document.getElementById('searchResults').innerHTML = html;
    }

    function initializeUi() {
      document.getElementById('searchInput').value = searchState.query;
      document.getElementById('resultsFilterInput').value = searchState.tableFilter;
      document.getElementById('pageSizeSelect').value = String(searchState.pageSize);
      document.getElementById('exactMatchToggle').checked = Boolean(searchState.exactMatch);
      // Restore search mode toggle
      var isOrg = searchState.searchMode === 'org';
      document.getElementById('modeLocal').classList.toggle('active', !isOrg);
      document.getElementById('modeOrg').classList.toggle('active', isOrg);
      document.getElementById('orgNotice').style.display = isOrg ? 'block' : 'none';
      document.getElementById('filtersRow').style.display = isOrg ? 'none' : 'flex';
      // Restore refresh button and cache badge for org mode
      var refreshBtn = document.getElementById('refreshOrgCacheButton');
      if (refreshBtn) { refreshBtn.style.display = isOrg ? 'inline-flex' : 'none'; }
      var badge = document.getElementById('cacheBadge');
      if (badge) {
        badge.style.display = (isOrg && searchState.orgCacheSize > 0) ? 'inline-flex' : 'none';
        if (searchState.orgCacheSize > 0) { badge.textContent = '✓ ' + searchState.orgCacheSize + ' cached'; }
      }
      syncFilterCheckboxes();
      renderStatus();
      renderSummaryPills(0, 0, 0, 0);
    }

    document.getElementById('searchButton').addEventListener('click', () => {
      doSearch();
    });

    document.getElementById('clearSearchButton').addEventListener('click', () => {
      clearSearch();
    });

    document.getElementById('resetTableButton').addEventListener('click', () => {
      resetTableState();
    });

    document.getElementById('clearFiltersButton').addEventListener('click', () => {
      setFilterPreset('none');
    });

    document.getElementById('selectAllFiltersButton').addEventListener('click', () => {
      setFilterPreset('all');
    });

    document.getElementById('sourceFiltersButton').addEventListener('click', () => {
      setFilterPreset('source');
    });

    document.getElementById('metadataFiltersButton').addEventListener('click', () => {
      setFilterPreset('metadata');
    });

    document.getElementById('searchInput').addEventListener('input', (event) => {
      clearTimeout(debounceTimer);
      debounceTimer = setTimeout(() => {
        if (event.target.value.trim().length >= 2) {
          doSearch();
        } else if (!event.target.value.trim()) {
          clearSearchResultsOnly();
        }
      }, 300);
    });

    document.getElementById('searchInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        clearTimeout(debounceTimer);
        doSearch();
      }
    });

    document.getElementById('resultsFilterInput').addEventListener('input', (event) => {
      updateTableFilter(event.target.value || '');
    });

    document.getElementById('pageSizeSelect').addEventListener('change', (event) => {
      updatePageSize(event.target.value);
    });

    document.getElementById('jumpToPageButton').addEventListener('click', () => {
      jumpToPage();
    });

    document.getElementById('jumpToPageInput').addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        jumpToPage();
      }
    });

    document.getElementById('exactMatchToggle').addEventListener('change', (event) => {
      searchState.exactMatch = event.target.checked;
      persistUiState();
      if (searchState.query) {
        doSearch();
      } else {
        renderStatus();
        renderSummaryPills(0, 0, 0, 0);
      }
    });

    document.querySelectorAll('.filter-cb').forEach((checkbox) => {
      checkbox.addEventListener('change', () => {
        syncFiltersFromUi(true);
      });
    });

    // Search mode toggle
    document.getElementById('modeLocal').addEventListener('click', () => {
      setSearchMode('local');
    });

    document.getElementById('modeOrg').addEventListener('click', () => {
      setSearchMode('org');
    });

    document.getElementById('refreshOrgCacheButton').addEventListener('click', () => {
      showLoading('Refreshing org cache…', 'Re-downloading all metadata from org');
      vscode.postMessage({ command: 'refreshOrgCache' });
    });

    // Global event delegation for dynamically-rendered buttons
    // (CSP blocks inline onclick; this handles all dynamic buttons)
    document.addEventListener('click', (e) => {
      const target = e.target.closest('[data-action]');
      if (!target) { return; }
      const action = target.dataset.action;
      if (action === 'openFile') {
        openFile(target.dataset.file, Number(target.dataset.line));
      } else if (action === 'copyText') {
        copyText(target.dataset.text);
      } else if (action === 'changePage') {
        changePage(Number(target.dataset.page));
      } else if (action === 'setSort') {
        setSort(target.dataset.key);
      }
    });

    window.addEventListener('keydown', (event) => {
      const activeElement = document.activeElement;
      const isTyping = activeElement && ['INPUT', 'TEXTAREA'].includes(activeElement.tagName);

      if (event.key === '/' && !isTyping) {
        event.preventDefault();
        document.getElementById('searchInput').focus();
        document.getElementById('searchInput').select();
      }

      if (event.key === 'Escape') {
        if (activeElement && activeElement.id === 'resultsFilterInput' && activeElement.value) {
          updateTableFilter('');
          activeElement.value = '';
        } else if (activeElement && activeElement.id === 'searchInput' && activeElement.value) {
          clearSearch();
        }
      }
    });

    window.addEventListener('message', (event) => {
      const message = event.data;

      if (message.command === 'searchResults') {
        hideLoading();
        const nextQuery = message.query || '';
        if (searchState.query !== nextQuery) {
          searchState.currentPage = 1;
        }
        searchState.query = nextQuery;
        searchState.exactMatch = Boolean(message.exactMatch);
        searchState.allResults = message.results || [];
        searchState.lastResultCount = message.totalResults || searchState.allResults.length;
        searchState.isLoading = false;

        if (message.cacheSize) {
          searchState.orgCacheSize = message.cacheSize;
          updateCacheBadge(message.cacheSize);
        }

        persistUiState();

        if (message.error) {
          renderEmptyState('Org Search Error', message.error);
          renderStatus();
          renderSummaryPills(0, 0, 0, 0);
        } else {
          renderCurrentResults();
        }
      } else if (message.command === 'orgCacheProgress') {
        showLoadingProgress(
          'Loading ' + (message.stage || '…'),
          message.done || 0,
          message.total || 8
        );
      } else if (message.command === 'orgCacheRefreshed') {
        hideLoading();
        searchState.orgCacheSize = message.cacheSize || 0;
        updateCacheBadge(searchState.orgCacheSize);
        // Re-run current search if there's a query
        if (searchState.query) {
          doSearch();
        }
      } else if (message.command === 'setQuery') {
        document.getElementById('searchInput').value = message.query;
        searchState.query = message.query || '';
        persistUiState();
      }
    });

    initializeUi();
    if (searchState.query) {
      doSearch();
    }
  </script>
</body>
</html>`;
  }
}

function getNonce(): string {
  let text = '';
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  for (let index = 0; index < 32; index++) {
    text += chars.charAt(Math.floor(Math.random() * chars.length));
  }
  return text;
}
