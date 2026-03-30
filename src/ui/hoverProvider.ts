import * as vscode from 'vscode';
import { MetadataIndexer } from '../indexing/metadataIndexer';

/**
 * Hover provider that shows a mini impact summary when hovering
 * over Salesforce API names (custom fields, objects, Apex classes).
 */
export class SfHoverProvider implements vscode.HoverProvider {
  private indexer: MetadataIndexer;

  constructor(indexer: MetadataIndexer) {
    this.indexer = indexer;
  }

  provideHover(
    document: vscode.TextDocument,
    position: vscode.Position,
  ): vscode.Hover | null {
    const config = vscode.workspace.getConfiguration('sfSearch');
    if (!config.get<boolean>('enableCodeLens', true)) {
      return null;
    }

    const wordRange = document.getWordRangeAtPosition(position, /[A-Za-z]\w*(?:__[crex])?/);
    if (!wordRange) {
      return null;
    }

    const word = document.getText(wordRange);
    if (word.length < 3) {
      return null;
    }

    const graph = this.indexer.getReferenceGraph();
    const normalizedWord = word.toLowerCase();
    let totalRefs = 0;
    const fileSet = new Set<string>();
    const typeSet = new Set<string>();

    for (const [keyword, entries] of graph.entries()) {
      const keyLower = keyword.toLowerCase();
      if (keyLower === normalizedWord) {
        for (const entry of entries) {
          totalRefs++;
          fileSet.add(entry.fileName);
          typeSet.add(entry.metadataType);
        }
      }
    }

    if (totalRefs === 0) {
      return null;
    }

    const md = new vscode.MarkdownString();
    md.isTrusted = true;
    md.supportThemeIcons = true;

    md.appendMarkdown(`**$(pulse) ImpactLens: \`${word}\`**\n\n`);
    md.appendMarkdown(`- **References:** ${totalRefs}\n`);
    md.appendMarkdown(`- **Files:** ${fileSet.size}\n`);
    md.appendMarkdown(`- **Types:** ${Array.from(typeSet).join(', ')}\n\n`);
    md.appendMarkdown(
      `[$(search) Search](command:sfSearch.search?${encodeURIComponent(JSON.stringify(word))}) ` +
      `| [$(pulse) Analyze Impact](command:sfSearch.analyzeImpact?${encodeURIComponent(JSON.stringify(word))})`
    );

    return new vscode.Hover(md, wordRange);
  }
}
