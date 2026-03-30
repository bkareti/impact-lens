import * as vscode from 'vscode';
import * as path from 'path';
import { DependencyNode } from '../models/dependencyNode';
import { ImpactAnalyzer } from '../search/impactAnalyzer';
import { getMetadataIcon } from './resultsView';
import { MetadataType, ImpactReport, RiskLevel } from '../models/searchResult';

/**
 * TreeDataProvider for the impact analysis sidebar view.
 * Shows a dependency tree rooted at the analyzed metadata element,
 * with rich tooltips, colored icons, and file-open commands.
 */
export class ImpactViewProvider implements vscode.TreeDataProvider<ImpactTreeItem> {
  private _onDidChangeTreeData = new vscode.EventEmitter<ImpactTreeItem | undefined | null>();
  readonly onDidChangeTreeData = this._onDidChangeTreeData.event;

  private impactAnalyzer: ImpactAnalyzer;
  private rootNode: DependencyNode | null = null;
  private analyzedName = '';
  private totalRefs = 0;
  private lastReport: ImpactReport | null = null;

  constructor(impactAnalyzer: ImpactAnalyzer) {
    this.impactAnalyzer = impactAnalyzer;
  }

  // ── Public API ──────────────────────────────────────────────────────────────

  /** Analyze and display impact for the given metadata name. */
  analyze(metadataName: string): void {
    this.analyzedName = metadataName;
    this.rootNode = this.impactAnalyzer.buildDependencyTree(metadataName);
    this.lastReport = this.impactAnalyzer.analyze(metadataName);
    this.totalRefs = this._countNodes(this.rootNode);
    this._onDidChangeTreeData.fire(undefined);
  }

  /** Get the last impact report (for export). */
  getLastReport(): ImpactReport | null {
    return this.lastReport;
  }

  /** Clear the impact tree. */
  clear(): void {
    this.rootNode = null;
    this.analyzedName = '';
    this.totalRefs = 0;
    this.lastReport = null;
    this._onDidChangeTreeData.fire(undefined);
  }

  // ── TreeDataProvider ────────────────────────────────────────────────────────

  getTreeItem(element: ImpactTreeItem): vscode.TreeItem {
    return element;
  }

  getChildren(element?: ImpactTreeItem): ImpactTreeItem[] {
    if (!element) {
      return this._getRootItems();
    }

    if (!element.node?.children?.length) {
      return [];
    }

    return this._buildChildItems(element.node.children);
  }

  // ── Private helpers ─────────────────────────────────────────────────────────

  private _getRootItems(): ImpactTreeItem[] {
    if (!this.rootNode) {
      const placeholder = new ImpactTreeItem(
        'Run impact analysis to see dependencies',
        vscode.TreeItemCollapsibleState.None,
        'placeholder'
      );
      placeholder.iconPath = new vscode.ThemeIcon(
        'target',
        new vscode.ThemeColor('disabledForeground')
      );
      return [placeholder];
    }

    // Summary header
    const leafCount = this.totalRefs;
    const riskBadge = this.lastReport ? ` • Risk: ${this.lastReport.riskLevel}` : '';
    const summary = new ImpactTreeItem(
      `Impact: "${this.analyzedName}"`,
      vscode.TreeItemCollapsibleState.None,
      'summary'
    );
    summary.description = `${leafCount} reference${leafCount !== 1 ? 's' : ''}${riskBadge}`;
    summary.iconPath = new vscode.ThemeIcon(
      'pulse',
      new vscode.ThemeColor(this._riskColor())
    );
    const riskDetails = this.lastReport
      ? `\n\nRisk: **${this.lastReport.riskLevel}** (score: ${this.lastReport.riskScore}/100)` +
        `\nAffected files: ${this.lastReport.affectedFiles}` +
        `\nMax depth: ${this.lastReport.maxDepthReached}` +
        (this.lastReport.hasCircularDeps ? '\n\n⚠ Circular dependencies detected' : '')
      : '';
    summary.tooltip = new vscode.MarkdownString(
      `**Impact Analysis**\n\nTarget: \`${this.analyzedName}\`\n\nTotal references found: **${leafCount}**${riskDetails}`
    );

    // Root node representing the analyzed element
    const hasChildren = (this.rootNode.children?.length ?? 0) > 0;
    const rootItem = new ImpactTreeItem(
      this.rootNode.name,
      hasChildren
        ? vscode.TreeItemCollapsibleState.Expanded
        : vscode.TreeItemCollapsibleState.None,
      'root'
    );
    rootItem.node = this.rootNode;
    rootItem.description = hasChildren
      ? `${this.rootNode.children.length} direct dep${this.rootNode.children.length !== 1 ? 's' : ''}`
      : 'no dependents';
    rootItem.iconPath = new vscode.ThemeIcon(
      'target',
      new vscode.ThemeColor('charts.red')
    );
    rootItem.tooltip = new vscode.MarkdownString(
      `**${this.rootNode.name}** _(analysis root)_\n\nDirect dependents: ${this.rootNode.children?.length ?? 0}`
    );

    if (this.rootNode.filePath) {
      rootItem.resourceUri = vscode.Uri.file(this.rootNode.filePath);
      rootItem.command = {
        title: 'Open File',
        command: 'sfSearch.openResult',
        arguments: [this.rootNode.filePath, this.rootNode.line ?? 1],
      };
    }

    return leafCount > 0 ? [summary, rootItem] : [rootItem];
  }

  private _buildChildItems(children: DependencyNode[]): ImpactTreeItem[] {
    // Sort: nodes with children (have dependents) first, then by ref count desc
    const sorted = [...children].sort((a, b) => {
      const aHas = (a.children?.length ?? 0) > 0 ? 1 : 0;
      const bHas = (b.children?.length ?? 0) > 0 ? 1 : 0;
      if (aHas !== bHas) {
        return bHas - aHas;
      }
      return (b.referenceCount ?? 0) - (a.referenceCount ?? 0);
    });

    return sorted.map((child) => {
      const hasChildren = (child.children?.length ?? 0) > 0;
      const fileName = child.filePath ? path.basename(child.filePath) : child.name;
      const relPath = child.filePath ? this._toRelativePath(child.filePath) : '';

      const item = new ImpactTreeItem(
        fileName,
        hasChildren
          ? vscode.TreeItemCollapsibleState.Collapsed
          : vscode.TreeItemCollapsibleState.None,
        hasChildren ? 'group' : 'leaf'
      );
      item.node = child;

      // Description: reference count + line number
      const parts: string[] = [];
      if ((child.referenceCount ?? 0) > 1) {
        parts.push(`×${child.referenceCount}`);
      }
      if (child.line) {
        parts.push(`:${child.line}`);
      }
      if (hasChildren) {
        parts.push(`${child.children.length} dep${child.children.length !== 1 ? 's' : ''}`);
      }
      item.description = parts.join('  ');

      // Rich tooltip
      const snippetLine = child.snippet?.trim().replace(/\s+/g, ' ') ?? '';
      const tooltipMd = new vscode.MarkdownString(
        [
          `**${child.name}**`,
          child.type ? `Type: \`${child.type}\`` : '',
          child.line ? `Line: ${child.line}` : '',
          relPath ? `\`${relPath}\`` : '',
          snippetLine ? `\n> ${snippetLine.substring(0, 100)}` : '',
        ]
          .filter(Boolean)
          .join('\n')
      );
      tooltipMd.isTrusted = true;
      item.tooltip = tooltipMd;

      // Icon: try to map type string → MetadataType enum, fall back gracefully
      item.iconPath = _getNodeIcon(child, hasChildren);

      if (child.filePath) {
        item.resourceUri = vscode.Uri.file(child.filePath);
        item.command = {
          title: 'Open File',
          command: 'sfSearch.openResult',
          arguments: [child.filePath, child.line ?? 1],
        };
        item.accessibilityInformation = {
          label: `${child.name}, ${child.type ?? 'unknown type'}, line ${child.line ?? 'unknown'}`,
        };
      }

      return item;
    });
  }

  private _riskColor(): string {
    if (!this.lastReport) { return 'charts.red'; }
    switch (this.lastReport.riskLevel) {
      case RiskLevel.Critical: return 'errorForeground';
      case RiskLevel.High: return 'charts.red';
      case RiskLevel.Medium: return 'charts.orange';
      case RiskLevel.Low: return 'charts.green';
      default: return 'charts.red';
    }
  }

  private _countNodes(node: DependencyNode | null): number {
    if (!node) {
      return 0;
    }
    return (node.referenceCount ?? 0) + (node.children ?? []).reduce(
      (sum, c) => sum + this._countNodes(c),
      0
    );
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
 * Pick a color-coded icon for a dependency node.
 * Maps the node's `type` string to a MetadataType enum value when possible.
 */
function _getNodeIcon(node: DependencyNode, hasChildren: boolean): vscode.ThemeIcon {
  if (node.type) {
    // Try exact match first
    const metaValues = Object.values(MetadataType) as string[];
    const matchedKey = Object.keys(MetadataType).find(
      (k) => (MetadataType as Record<string, string>)[k] === node.type
    );
    if (matchedKey) {
      return getMetadataIcon((MetadataType as Record<string, MetadataType>)[matchedKey]);
    }
    // Fuzzy fallbacks
    const t = node.type.toLowerCase();
    if (t.includes('apex') && t.includes('class')) {
      return getMetadataIcon(MetadataType.ApexClass);
    }
    if (t.includes('trigger')) {
      return getMetadataIcon(MetadataType.ApexTrigger);
    }
    if (t.includes('lwc') || t.includes('lightning web')) {
      return getMetadataIcon(MetadataType.LWC);
    }
    if (t.includes('aura')) {
      return getMetadataIcon(MetadataType.Aura);
    }
    if (t.includes('flow')) {
      return getMetadataIcon(MetadataType.Flow);
    }
    if (t.includes('object')) {
      return getMetadataIcon(MetadataType.CustomObject);
    }
    if (t.includes('field')) {
      return getMetadataIcon(MetadataType.CustomField);
    }
    if (t.includes('permission') || t.includes('permset')) {
      return getMetadataIcon(MetadataType.PermissionSet);
    }
    if (t.includes('profile')) {
      return getMetadataIcon(MetadataType.Profile);
    }
    if (t.includes('layout')) {
      return getMetadataIcon(MetadataType.Layout);
    }
    if (t.includes('validation')) {
      return getMetadataIcon(MetadataType.ValidationRule);
    }
    if (t.includes('root')) {
      return new vscode.ThemeIcon('target', new vscode.ThemeColor('charts.red'));
    }
    void metaValues; // suppress unused warning
  }
  if (hasChildren) {
    return new vscode.ThemeIcon('folder', new vscode.ThemeColor('charts.blue'));
  }
  return new vscode.ThemeIcon('file-code', new vscode.ThemeColor('charts.green'));
}

/**
 * Tree item for the impact analysis view.
 */
export class ImpactTreeItem extends vscode.TreeItem {
  node?: DependencyNode;

  constructor(
    label: string,
    collapsibleState: vscode.TreeItemCollapsibleState,
    contextValue: string
  ) {
    super(label, collapsibleState);
    this.contextValue = contextValue;
  }
}
