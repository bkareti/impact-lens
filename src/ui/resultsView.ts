import * as vscode from 'vscode';
import * as path from 'path';
import { SearchResult, MetadataType } from '../models/searchResult';

// ─── Sort options ────────────────────────────────────────────────────────────
type SortKey = 'score' | 'file' | 'line';
type SortDir = 'asc' | 'desc';

// ─── Group collapse memory ───────────────────────────────────────────────────
const collapsedGroups = new Set<string>();

/**
 * TreeDataProvider for the search results sidebar view.
 * Groups results by metadata type, sorted by relevance score (highest first).
 * Supports copy-path and reveal-in-explorer context menu actions.
 */
export class ResultsViewProvider implements vscode.TreeDataProvider<ResultTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ResultTreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private results: SearchResult[] = [];
  private query = '';
  private sortKey: SortKey = 'score';
  private sortDir: SortDir = 'desc';

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Update the results displayed in the tree view. */
  setResults(results: SearchResult[], query: string): void {
    this.results = results;
    this.query = query;
    collapsedGroups.clear(); // Re-expand all groups on new results
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Clear all results. */
  clear(): void {
    this.results = [];
    this.query = '';
    collapsedGroups.clear();
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Get the current results (for export). */
  getResults(): SearchResult[] {
    return [...this.results];
  }

  /** Change sort order and refresh. */
  setSortKey(key: SortKey, dir: SortDir): void {
    this.sortKey = key;
    this.sortDir = dir;
    this._onDidChangeTreeData.fire(undefined);
  }

  // ── TreeDataProvider ────────────────────────────────────────────────────────

  getTreeItem(element: ResultTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ResultTreeItem): ResultTreeItem[] {
    if (!element) {
      return this._getRootItems();
    }

    if (element.contextValue === 'group' && element.metadataType) {
      return this._getGroupChildren(element.metadataType);
    }

    return [];
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _getRootItems(): ResultTreeItem[] {
    if (this.results.length === 0) {
      const placeholder = new ResultTreeItem(
        'Run a search to see results here',
        vscode.TreeItemCollapsibleState.None,
        'placeholder'
      );
      placeholder.iconPath = new vscode.ThemeIcon(
        'search',
        new vscode.ThemeColor('disabledForeground')
      );
      return [placeholder];
    }

    // Summary header
    const summary = new ResultTreeItem(
      `${this.results.length} result${this.results.length !== 1 ? 's' : ''} for "${this.query}"`,
      vscode.TreeItemCollapsibleState.None,
      'summary'
    );
    summary.iconPath = new vscode.ThemeIcon('list-flat');
    summary.tooltip = `Query: ${this.query}\nTotal matches: ${this.results.length}`;

    // Group by metadata type, sorted by group size desc
    const grouped = new Map<MetadataType, SearchResult[]>();
    for (const result of this.results) {
      const existing = grouped.get(result.metadataType) ?? [];
      existing.push(result);
      grouped.set(result.metadataType, existing);
    }

    const sortedGroups = [...grouped.entries()].sort(
      (a, b) => b[1].length - a[1].length
    );

    const groupItems: ResultTreeItem[] = sortedGroups.map(([type, groupResults]) => {
      const isCollapsed = collapsedGroups.has(type);
      const item = new ResultTreeItem(
        type,
        isCollapsed
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.Expanded,
        'group',
        type
      );
      item.description = `${groupResults.length} match${groupResults.length !== 1 ? 'es' : ''}`;
      item.iconPath = getMetadataIcon(type);
      item.tooltip = new vscode.MarkdownString(
        `**${type}**\n\n${groupResults.length} result${groupResults.length !== 1 ? 's' : ''} matching _${this.query}_`
      );
      return item;
    });

    return [summary, ...groupItems];
  }

  private _getGroupChildren(metadataType: MetadataType): ResultTreeItem[] {
    const filtered = this.results.filter((r) => r.metadataType === metadataType);
    const sorted = this._sortResults(filtered);

    return sorted.map((r) => {
      const fileName = path.basename(r.filePath);
      const relPath = this._toRelativePath(r.filePath);
      const snippet = r.snippet?.trim().replace(/\s+/g, ' ') ?? '';
      const preview = snippet.length > 90 ? snippet.substring(0, 87) + '…' : snippet;

      const item = new ResultTreeItem(
        fileName,
        vscode.TreeItemCollapsibleState.None,
        'result',
        metadataType
      );

      // Description: object name + line number for quick scanning
      const linePart = r.line > 0 ? `  :${r.line}` : '';
      const objPart = r.objectName ? `${r.objectName}  ` : '';
      item.description = `${objPart}${linePart}`;

      // Rich tooltip with full context
      const tooltipMd = new vscode.MarkdownString(
        [
          `**${fileName}**`,
          r.line > 0 ? `Line ${r.line}` : '',
          r.objectName ? `Object: \`${r.objectName}\`` : '',
          `Score: ${r.score.toFixed(3)}`,
          '',
          `\`${relPath}\``,
          '',
          preview ? `> ${preview}` : '',
        ]
          .filter((l) => l !== undefined && l !== null)
          .join('\n')
      );
      tooltipMd.isTrusted = true;
      item.tooltip = tooltipMd;

      // Open on click
      item.command = {
        title: 'Open File',
        command: 'sfSearch.openResult',
        arguments: [r.filePath, r.line],
      };

      item.resourceUri = vscode.Uri.file(r.filePath);
      item.accessibilityInformation = {
        label: `${fileName}, line ${r.line}, ${metadataType}`,
      };

      return item;
    });
  }

  private _sortResults(results: SearchResult[]): SearchResult[] {
    return [...results].sort((a, b) => {
      let cmp = 0;
      if (this.sortKey === 'score') {
        cmp = a.score - b.score;
      } else if (this.sortKey === 'file') {
        cmp = a.fileName.localeCompare(b.fileName, undefined, { sensitivity: 'base' });
      } else if (this.sortKey === 'line') {
        cmp = a.line - b.line;
      }
      return this.sortDir === 'desc' ? -cmp : cmp;
    });
  }

  private _toRelativePath(filePath: string): string {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (workspaceFolders && workspaceFolders.length > 0) {
      const root = workspaceFolders[0].uri.fsPath;
      if (filePath.startsWith(root)) {
        return filePath.slice(root.length + 1);
      }
    }
    return filePath;
  }
}

/**
 * Tree item for the results view.
 */
export class ResultTreeItem extends vscode.TreeItem {
  metadataType?: MetadataType;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    contextValue: string,
    metadataType?: MetadataType
  ) {
    super(label, collapsibleState);
    this.contextValue = contextValue;
    this.metadataType = metadataType;
  }
}

/**
 * Get a themed icon for each metadata type.
 */
export function getMetadataIcon(type: MetadataType): vscode.ThemeIcon {
  switch (type) {
    case MetadataType.ApexClass:
      return new vscode.ThemeIcon('symbol-class', new vscode.ThemeColor('charts.blue'));
    case MetadataType.ApexTrigger:
      return new vscode.ThemeIcon('zap', new vscode.ThemeColor('charts.orange'));
    case MetadataType.LWC:
      return new vscode.ThemeIcon('symbol-event', new vscode.ThemeColor('charts.green'));
    case MetadataType.Aura:
      return new vscode.ThemeIcon('flame', new vscode.ThemeColor('charts.yellow'));
    case MetadataType.Flow:
      return new vscode.ThemeIcon('type-hierarchy', new vscode.ThemeColor('charts.purple'));
    case MetadataType.ValidationRule:
      return new vscode.ThemeIcon('verified', new vscode.ThemeColor('charts.red'));
    case MetadataType.WorkflowRule:
      return new vscode.ThemeIcon('gear', new vscode.ThemeColor('charts.orange'));
    case MetadataType.CustomObject:
      return new vscode.ThemeIcon('database', new vscode.ThemeColor('charts.blue'));
    case MetadataType.CustomField:
      return new vscode.ThemeIcon('symbol-field', new vscode.ThemeColor('charts.green'));
    case MetadataType.CustomMetadata:
      return new vscode.ThemeIcon('symbol-struct', new vscode.ThemeColor('charts.purple'));
    case MetadataType.PermissionSet:
      return new vscode.ThemeIcon('shield', new vscode.ThemeColor('charts.yellow'));
    case MetadataType.Profile:
      return new vscode.ThemeIcon('person', new vscode.ThemeColor('charts.blue'));
    case MetadataType.Layout:
      return new vscode.ThemeIcon('layout', new vscode.ThemeColor('charts.green'));
    case MetadataType.Report:
      return new vscode.ThemeIcon('graph', new vscode.ThemeColor('charts.blue'));
    case MetadataType.EmailTemplate:
      return new vscode.ThemeIcon('mail', new vscode.ThemeColor('charts.orange'));
    case MetadataType.NamedCredential:
      return new vscode.ThemeIcon('key', new vscode.ThemeColor('charts.red'));
    case MetadataType.PlatformEvent:
      return new vscode.ThemeIcon('broadcast', new vscode.ThemeColor('charts.purple'));
    case MetadataType.VisualforcePage:
      return new vscode.ThemeIcon('file-code', new vscode.ThemeColor('charts.blue'));
    case MetadataType.VisualforceComponent:
      return new vscode.ThemeIcon('symbol-misc', new vscode.ThemeColor('charts.green'));
    case MetadataType.CustomLabel:
      return new vscode.ThemeIcon('tag', new vscode.ThemeColor('charts.yellow'));
    case MetadataType.StaticResource:
      return new vscode.ThemeIcon('file-zip', new vscode.ThemeColor('charts.orange'));
    case MetadataType.FlexiPage:
      return new vscode.ThemeIcon('browser', new vscode.ThemeColor('charts.purple'));
    case MetadataType.ApprovalProcess:
      return new vscode.ThemeIcon('checklist', new vscode.ThemeColor('charts.green'));
    case MetadataType.SharingRule:
      return new vscode.ThemeIcon('lock', new vscode.ThemeColor('charts.yellow'));
    case MetadataType.RecordType:
      return new vscode.ThemeIcon('list-tree', new vscode.ThemeColor('charts.blue'));
    case MetadataType.QuickAction:
      return new vscode.ThemeIcon('play', new vscode.ThemeColor('charts.orange'));
    case MetadataType.GlobalValueSet:
      return new vscode.ThemeIcon('symbol-enum', new vscode.ThemeColor('charts.purple'));
    case MetadataType.CustomSetting:
      return new vscode.ThemeIcon('settings-gear', new vscode.ThemeColor('charts.red'));
    default:
      return new vscode.ThemeIcon('file');
  }
}
