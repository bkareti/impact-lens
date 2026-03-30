import * as vscode from 'vscode';
import { MetadataIndexer } from '../indexing/metadataIndexer';

/**
 * CodeLens provider that shows reference counts above Apex class, trigger,
 * LWC component, and Aura component declarations.
 */
export class SfCodeLensProvider implements vscode.CodeLensProvider {
  private indexer: MetadataIndexer;
  private _onDidChangeCodeLenses = new vscode.EventEmitter<void>();
  public readonly onDidChangeCodeLenses = this._onDidChangeCodeLenses.event;

  constructor(indexer: MetadataIndexer) {
    this.indexer = indexer;

    // Refresh lenses when the index is rebuilt
    indexer.onIndexUpdated(() => {
      this._onDidChangeCodeLenses.fire();
    });
  }

  provideCodeLenses(document: vscode.TextDocument): vscode.CodeLens[] {
    const config = vscode.workspace.getConfiguration('sfSearch');
    if (!config.get<boolean>('enableCodeLens', true)) {
      return [];
    }

    const lenses: vscode.CodeLens[] = [];
    const ext = document.fileName.split('.').pop()?.toLowerCase();

    if (ext === 'cls' || ext === 'trigger') {
      this.addApexLenses(document, lenses);
    } else if (ext === 'js' && document.fileName.includes('/lwc/')) {
      this.addLwcLenses(document, lenses);
    } else if ((ext === 'cmp' || ext === 'app') && document.fileName.includes('/aura/')) {
      this.addAuraLenses(document, lenses);
    }

    return lenses;
  }

  resolveCodeLens(codeLens: vscode.CodeLens): vscode.CodeLens {
    return codeLens;
  }

  private addApexLenses(document: vscode.TextDocument, lenses: vscode.CodeLens[]): void {
    const classDeclPattern = /\b(?:class|interface|enum|trigger)\s+(\w+)/g;
    const text = document.getText();
    let match: RegExpExecArray | null;

    while ((match = classDeclPattern.exec(text)) !== null) {
      const name = match[1];
      const pos = document.positionAt(match.index);
      const range = new vscode.Range(pos, pos);
      const refCount = this.countReferences(name);

      lenses.push(
        new vscode.CodeLens(range, {
          title: `$(references) ${refCount} reference${refCount !== 1 ? 's' : ''}`,
          tooltip: `${refCount} reference${refCount !== 1 ? 's' : ''} to ${name} found in project`,
          command: 'sfSearch.analyzeImpact',
          arguments: [name],
        })
      );
    }
  }

  private addLwcLenses(document: vscode.TextDocument, lenses: vscode.CodeLens[]): void {
    // Use the component folder name as the identifier
    const parts = document.fileName.replace(/\\/g, '/').split('/');
    const lwcIdx = parts.indexOf('lwc');
    if (lwcIdx >= 0 && lwcIdx + 1 < parts.length) {
      const componentName = parts[lwcIdx + 1];
      const range = new vscode.Range(0, 0, 0, 0);
      const refCount = this.countReferences(componentName);

      lenses.push(
        new vscode.CodeLens(range, {
          title: `$(references) ${refCount} reference${refCount !== 1 ? 's' : ''}`,
          tooltip: `${refCount} reference${refCount !== 1 ? 's' : ''} to ${componentName}`,
          command: 'sfSearch.analyzeImpact',
          arguments: [componentName],
        })
      );
    }
  }

  private addAuraLenses(document: vscode.TextDocument, lenses: vscode.CodeLens[]): void {
    const parts = document.fileName.replace(/\\/g, '/').split('/');
    const auraIdx = parts.indexOf('aura');
    if (auraIdx >= 0 && auraIdx + 1 < parts.length) {
      const componentName = parts[auraIdx + 1];
      const range = new vscode.Range(0, 0, 0, 0);
      const refCount = this.countReferences(componentName);

      lenses.push(
        new vscode.CodeLens(range, {
          title: `$(references) ${refCount} reference${refCount !== 1 ? 's' : ''}`,
          tooltip: `${refCount} reference${refCount !== 1 ? 's' : ''} to ${componentName}`,
          command: 'sfSearch.analyzeImpact',
          arguments: [componentName],
        })
      );
    }
  }

  private countReferences(name: string): number {
    const graph = this.indexer.getReferenceGraph();
    const normalizedName = name.toLowerCase();
    let count = 0;

    for (const [keyword, entries] of graph.entries()) {
      const keyLower = keyword.toLowerCase();
      if (keyLower === normalizedName || keyLower.includes(normalizedName)) {
        count += entries.length;
      }
    }

    return count;
  }
}
