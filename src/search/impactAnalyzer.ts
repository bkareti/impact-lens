import * as vscode from 'vscode';
import {
  MetadataType,
  ReferenceEntry,
  ImpactReport,
  RiskLevel,
  ExportFormat,
} from '../models/searchResult';
import { DependencyNode, DependencyGraph, DependencyEdge } from '../models/dependencyNode';
import { MetadataIndexer } from '../indexing/metadataIndexer';

// ── Risk weights per metadata type ──────────────────────────────────────────

const TYPE_RISK_WEIGHTS: Record<string, number> = {
  [MetadataType.ApexTrigger]: 10,
  [MetadataType.ApexClass]: 8,
  [MetadataType.Flow]: 7,
  [MetadataType.ValidationRule]: 7,
  [MetadataType.LWC]: 6,
  [MetadataType.Aura]: 6,
  [MetadataType.PermissionSet]: 5,
  [MetadataType.Profile]: 5,
  [MetadataType.WorkflowRule]: 5,
  [MetadataType.CustomObject]: 4,
  [MetadataType.CustomField]: 4,
  [MetadataType.Layout]: 3,
  [MetadataType.VisualforcePage]: 4,
  [MetadataType.VisualforceComponent]: 3,
  [MetadataType.CustomLabel]: 2,
  [MetadataType.CustomMetadata]: 3,
  [MetadataType.FlexiPage]: 2,
  [MetadataType.Report]: 2,
  [MetadataType.EmailTemplate]: 1,
  [MetadataType.StaticResource]: 1,
};

/**
 * Analyzes the impact of changing or deleting a Salesforce metadata element.
 * v3.0: Multi-hop traversal with cycle detection and risk scoring.
 */
export class ImpactAnalyzer {
  private indexer: MetadataIndexer;
  private outputChannel: vscode.OutputChannel;

  constructor(indexer: MetadataIndexer, outputChannel: vscode.OutputChannel) {
    this.indexer = indexer;
    this.outputChannel = outputChannel;
  }

  /**
   * Get the configured max traversal depth.
   */
  private getMaxDepth(): number {
    const config = vscode.workspace.getConfiguration('sfSearch');
    return Math.min(config.get<number>('impactDepth', 3), 5);
  }

  /**
   * Analyze the impact of a metadata element with multi-hop traversal.
   */
  analyze(metadataName: string): ImpactReport {
    const startTime = Date.now();
    const graph = this.indexer.getReferenceGraph();
    const allReferences: ReferenceEntry[] = [];
    const visited = new Set<string>(); // cycle detection: tracks filePath keys
    let hasCircularDeps = false;
    let maxDepthReached = 0;
    const maxDepth = this.getMaxDepth();

    // Recursive multi-hop walker
    const walkReferences = (name: string, depth: number): void => {
      if (depth > maxDepth) { return; }
      maxDepthReached = Math.max(maxDepthReached, depth);
      const normalizedName = name.toLowerCase();

      for (const [keyword, entries] of graph.entries()) {
        const keyLower = keyword.toLowerCase();
        if (
          keyLower === normalizedName ||
          keyLower.includes(normalizedName) ||
          normalizedName.includes(keyLower)
        ) {
          for (const entry of entries) {
            const key = `${entry.filePath}:${entry.line}`;
            if (visited.has(key)) {
              hasCircularDeps = true;
              continue;
            }
            visited.add(key);
            allReferences.push(entry);

            // Multi-hop: follow references from this file (by its base name without extension)
            if (depth < maxDepth) {
              const baseName = entry.fileName.replace(/\.\w+$/, '');
              if (baseName.toLowerCase() !== normalizedName) {
                walkReferences(baseName, depth + 1);
              }
            }
          }
        }
      }
    };

    // Start the walk at depth 0
    walkReferences(metadataName, 0);

    // Also handle Object.Field patterns
    const parts = metadataName.split('.');
    if (parts.length === 1) {
      for (const [keyword, entries] of graph.entries()) {
        const keyParts = keyword.split('.');
        if (keyParts.length === 2 && keyParts[1].toLowerCase() === metadataName.toLowerCase()) {
          for (const entry of entries) {
            const key = `${entry.filePath}:${entry.line}`;
            if (!visited.has(key)) {
              visited.add(key);
              allReferences.push(entry);
            }
          }
        }
      }
    }

    if (parts.length === 2) {
      const fieldOnly = parts[1].toLowerCase();
      for (const [keyword, entries] of graph.entries()) {
        if (keyword.toLowerCase() === fieldOnly) {
          for (const entry of entries) {
            const key = `${entry.filePath}:${entry.line}`;
            if (!visited.has(key)) {
              visited.add(key);
              allReferences.push(entry);
            }
          }
        }
      }
    }

    // Group by metadata type
    const byType = new Map<MetadataType, ReferenceEntry[]>();
    const uniqueFiles = new Set<string>();
    for (const ref of allReferences) {
      uniqueFiles.add(ref.filePath);
      const existing = byType.get(ref.metadataType) ?? [];
      existing.push(ref);
      byType.set(ref.metadataType, existing);
    }

    // Build summary counts
    const summaryCounts: Record<string, number> = {};
    for (const [type, entries] of byType.entries()) {
      summaryCounts[type] = entries.length;
    }

    // Compute risk score
    const { riskScore, riskLevel } = this.computeRisk(allReferences, uniqueFiles.size, maxDepthReached);

    const elapsed = Date.now() - startTime;
    this.outputChannel.appendLine(
      `[Impact] Analysis for "${metadataName}": ${allReferences.length} references, ` +
      `${uniqueFiles.size} files, risk=${riskLevel} (${riskScore}), ` +
      `depth=${maxDepthReached}, circular=${hasCircularDeps}, ${elapsed}ms.`
    );

    return {
      metadataName,
      generatedAt: Date.now(),
      totalReferences: allReferences.length,
      byType,
      summaryCounts,
      riskLevel,
      riskScore,
      affectedFiles: uniqueFiles.size,
      hasCircularDeps,
      maxDepthReached,
    };
  }

  /**
   * Compute a risk score (0-100) and level based on references.
   */
  private computeRisk(
    refs: ReferenceEntry[],
    fileCount: number,
    depth: number
  ): { riskScore: number; riskLevel: RiskLevel } {
    if (refs.length === 0) {
      return { riskScore: 0, riskLevel: RiskLevel.Low };
    }

    // Sum type weights
    let typeScore = 0;
    for (const ref of refs) {
      const weight = TYPE_RISK_WEIGHTS[ref.metadataType] ?? 1;
      // Test classes are lower risk
      const isTest = ref.fileName.toLowerCase().includes('test');
      typeScore += isTest ? weight * 0.3 : weight;
    }

    // Normalize: base on reference count + file spread + depth
    const refFactor = Math.min(refs.length / 50, 1) * 30;        // max 30 pts
    const fileFactor = Math.min(fileCount / 20, 1) * 25;          // max 25 pts
    const depthFactor = Math.min(depth / 3, 1) * 15;              // max 15 pts
    const typeFactor = Math.min(typeScore / 100, 1) * 30;         // max 30 pts

    const riskScore = Math.min(100, Math.round(refFactor + fileFactor + depthFactor + typeFactor));

    let riskLevel: RiskLevel;
    if (riskScore >= 75) {
      riskLevel = RiskLevel.Critical;
    } else if (riskScore >= 50) {
      riskLevel = RiskLevel.High;
    } else if (riskScore >= 25) {
      riskLevel = RiskLevel.Medium;
    } else {
      riskLevel = RiskLevel.Low;
    }

    return { riskScore, riskLevel };
  }

  /**
   * Build a dependency tree rooted at the given metadata name.
   * v3.0: includes depth tracking and risk per node.
   */
  buildDependencyTree(metadataName: string): DependencyNode {
    const report = this.analyze(metadataName);
    const root: DependencyNode = {
      name: metadataName,
      type: 'Root',
      filePath: '',
      children: [],
      referenceCount: report.totalReferences,
      riskLevel: report.riskLevel,
      depth: 0,
    };

    for (const [type, entries] of report.byType.entries()) {
      const typeNode: DependencyNode = {
        name: type,
        type: type,
        filePath: '',
        children: [],
        referenceCount: entries.length,
        depth: 1,
      };

      for (const entry of entries) {
        typeNode.children.push({
          name: entry.fileName,
          type: entry.metadataType,
          filePath: entry.filePath,
          children: [],
          referenceCount: 1,
          line: entry.line,
          snippet: entry.snippet,
          depth: 2,
        });
      }

      root.children.push(typeNode);
    }

    return root;
  }

  /**
   * Build a full dependency graph for visualization.
   */
  buildDependencyGraph(metadataName: string): DependencyGraph {
    const report = this.analyze(metadataName);
    const nodes = new Map<string, DependencyNode>();
    const edges: DependencyEdge[] = [];

    nodes.set(metadataName, {
      name: metadataName,
      type: 'Root',
      filePath: '',
      children: [],
      referenceCount: report.totalReferences,
      riskLevel: report.riskLevel,
      depth: 0,
    });

    for (const [type, entries] of report.byType.entries()) {
      for (const entry of entries) {
        if (!nodes.has(entry.fileName)) {
          nodes.set(entry.fileName, {
            name: entry.fileName,
            type: entry.metadataType,
            filePath: entry.filePath,
            children: [],
            referenceCount: 1,
          });
        }

        edges.push({
          source: metadataName,
          sourceType: 'Root',
          target: entry.fileName,
          targetType: type,
          line: entry.line,
          filePath: entry.filePath,
        });
      }
    }

    return { nodes, edges };
  }

  /**
   * Get a formatted text summary of the impact analysis.
   */
  formatReport(report: ImpactReport): string {
    const lines: string[] = [];
    lines.push(`Impact Analysis: ${report.metadataName}`);
    lines.push('═'.repeat(50));
    lines.push('');
    lines.push(`Total References: ${report.totalReferences}`);
    lines.push(`Affected Files:   ${report.affectedFiles}`);
    lines.push(`Risk Level:       ${report.riskLevel} (score: ${report.riskScore}/100)`);
    lines.push(`Max Depth:        ${report.maxDepthReached}`);
    if (report.hasCircularDeps) {
      lines.push(`⚠ Circular dependencies detected`);
    }
    lines.push('');

    if (report.totalReferences === 0) {
      lines.push('No references found in the current project.');
      return lines.join('\n');
    }

    lines.push('Referenced in:');
    lines.push('');

    for (const [type, count] of Object.entries(report.summaryCounts)) {
      lines.push(`  ${type}: ${count}`);
    }

    lines.push('');
    lines.push('─'.repeat(50));
    lines.push('');

    for (const [type, entries] of report.byType.entries()) {
      lines.push(`▸ ${type}`);
      for (const entry of entries) {
        lines.push(`    ${entry.fileName} (line ${entry.line})`);
        if (entry.snippet) {
          lines.push(`      ${entry.snippet.split('\n')[0].trim()}`);
        }
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /**
   * Export the impact report in the specified format.
   */
  exportReport(report: ImpactReport, format: ExportFormat): string {
    switch (format) {
      case ExportFormat.Markdown:
        return this.exportMarkdown(report);
      case ExportFormat.CSV:
        return this.exportCsv(report);
      case ExportFormat.JSON:
        return this.exportJson(report);
      default:
        return this.formatReport(report);
    }
  }

  private exportMarkdown(report: ImpactReport): string {
    const lines: string[] = [];
    lines.push(`# Impact Analysis: \`${report.metadataName}\``);
    lines.push('');
    lines.push(`| Metric | Value |`);
    lines.push(`|--------|-------|`);
    lines.push(`| Total References | ${report.totalReferences} |`);
    lines.push(`| Affected Files | ${report.affectedFiles} |`);
    lines.push(`| Risk Level | **${report.riskLevel}** (${report.riskScore}/100) |`);
    lines.push(`| Max Depth | ${report.maxDepthReached} |`);
    lines.push(`| Circular Deps | ${report.hasCircularDeps ? '⚠ Yes' : 'No'} |`);
    lines.push('');

    if (report.totalReferences > 0) {
      lines.push('## References by Type');
      lines.push('');
      lines.push('| File | Type | Object | Line | Snippet |');
      lines.push('|------|------|--------|------|---------|');

      for (const [type, entries] of report.byType.entries()) {
        for (const entry of entries) {
          const snippet = (entry.snippet?.split('\n')[0]?.trim() ?? '').substring(0, 80);
          lines.push(`| ${entry.fileName} | ${type} | ${entry.objectName || '—'} | ${entry.line} | \`${snippet}\` |`);
        }
      }
    }

    return lines.join('\n');
  }

  private exportCsv(report: ImpactReport): string {
    const rows: string[] = ['File,Type,Object,Line,Snippet'];

    for (const [type, entries] of report.byType.entries()) {
      for (const entry of entries) {
        const snippet = (entry.snippet?.split('\n')[0]?.trim() ?? '').replace(/"/g, '""');
        rows.push(`"${entry.fileName}","${type}","${entry.objectName || ''}",${entry.line},"${snippet}"`);
      }
    }

    return rows.join('\n');
  }

  private exportJson(report: ImpactReport): string {
    const data = {
      metadataName: report.metadataName,
      generatedAt: new Date(report.generatedAt).toISOString(),
      totalReferences: report.totalReferences,
      affectedFiles: report.affectedFiles,
      riskLevel: report.riskLevel,
      riskScore: report.riskScore,
      maxDepthReached: report.maxDepthReached,
      hasCircularDeps: report.hasCircularDeps,
      references: {} as Record<string, Array<{ file: string; line: number; object: string; snippet: string }>>,
    };

    for (const [type, entries] of report.byType.entries()) {
      data.references[type] = entries.map(e => ({
        file: e.fileName,
        line: e.line,
        object: e.objectName,
        snippet: (e.snippet?.split('\n')[0]?.trim() ?? ''),
      }));
    }

    return JSON.stringify(data, null, 2);
  }
}
