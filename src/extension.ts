import * as vscode from 'vscode';
import { MetadataIndexer } from './indexing/metadataIndexer';
import { SearchEngine } from './search/searchEngine';
import { ImpactAnalyzer } from './search/impactAnalyzer';
import { SalesforceService } from './services/salesforceService';
import { SearchPanel, SearchEvent } from './ui/searchPanel';
import { ResultsViewProvider } from './ui/resultsView';
import { ImpactViewProvider } from './ui/impactView';
import { SfCodeLensProvider } from './ui/codeLensProvider';
import { SfHoverProvider } from './ui/hoverProvider';
import { ExportFormat } from './models/searchResult';

let outputChannel: vscode.OutputChannel;
let statusBarItem: vscode.StatusBarItem;

/**
 * Extension activation — called when a workspace with sfdx-project.json is opened.
 */
export async function activate(context: vscode.ExtensionContext): Promise<void> {
  outputChannel = vscode.window.createOutputChannel('ImpactLens');
  outputChannel.appendLine('[ImpactLens] Extension activating…');

  // Status bar
  statusBarItem = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    50
  );
  statusBarItem.text = '$(loading~spin) ImpactLens: Indexing…';
  statusBarItem.tooltip = 'ImpactLens - Salesforce Dependency Analyzer';
  statusBarItem.command = 'sfSearch.search';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Services
  const sfService = new SalesforceService(outputChannel);
  const indexer = new MetadataIndexer(context, outputChannel);
  const searchEngine = new SearchEngine(indexer, outputChannel);
  const impactAnalyzer = new ImpactAnalyzer(indexer, outputChannel);

  // Tree view providers
  const resultsView = new ResultsViewProvider();
  const impactView = new ImpactViewProvider(impactAnalyzer);

  const resultsTreeView = vscode.window.createTreeView('sfSearch.resultsView', {
    treeDataProvider: resultsView,
  });
  const impactTreeView = vscode.window.createTreeView('sfSearch.impactView', {
    treeDataProvider: impactView,
  });

  // Wire search panel events → tree views
  let searchPanelSub: vscode.Disposable | undefined;

  function wireSearchPanel(panel: SearchPanel): void {
    // Dispose previous subscription if panel was recreated
    searchPanelSub?.dispose();
    searchPanelSub = panel.onDidSearch((e: SearchEvent) => {
      // Update Results tree with search results
      resultsView.setResults(e.results, e.query);
      // Run Impact Analysis for the same query and update Impact tree
      impactView.analyze(e.query);
    });
  }

  // Auto-open the Search Panel when the sidebar container becomes visible
  resultsTreeView.onDidChangeVisibility((e) => {
    if (e.visible) {
      const panel = SearchPanel.createOrShow(context.extensionUri, searchEngine, sfService);
      wireSearchPanel(panel);
    }
  });

  context.subscriptions.push(resultsTreeView, impactTreeView);

  // CodeLens & Hover providers (Apex, LWC, Aura, VF)
  const codeLensProvider = new SfCodeLensProvider(indexer);
  const hoverProvider = new SfHoverProvider(indexer);
  const codeLensLanguages = [
    { language: 'apex' },
    { language: 'javascript', pattern: '**/lwc/**/*.js' },
    { language: 'html', pattern: '**/lwc/**/*.html' },
    { language: 'html', pattern: '**/aura/**/*.cmp' },
    { language: 'visualforce' },
  ];
  const hoverLanguages = [
    { language: 'apex' },
    { language: 'javascript', pattern: '**/lwc/**/*.js' },
    { language: 'html', pattern: '**/aura/**/*.cmp' },
    { language: 'visualforce' },
  ];

  for (const selector of codeLensLanguages) {
    context.subscriptions.push(
      vscode.languages.registerCodeLensProvider(selector, codeLensProvider)
    );
  }
  for (const selector of hoverLanguages) {
    context.subscriptions.push(
      vscode.languages.registerHoverProvider(selector, hoverProvider)
    );
  }

  // ─── Commands ──────────────────────────────────────────────────────

  // 1. Open search panel
  context.subscriptions.push(
    vscode.commands.registerCommand('sfSearch.search', (query?: string) => {
      const panel = SearchPanel.createOrShow(
        context.extensionUri,
        searchEngine,
        sfService
      );
      wireSearchPanel(panel);
      if (typeof query === 'string' && query.length > 0) {
        panel.triggerSearch(query);
      }
    })
  );

  // 2. Impact analysis (via command palette or context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand('sfSearch.impactAnalysis', async () => {
      // If invoked from context menu with selection, use it; otherwise prompt
      let input: string | undefined;
      const editor = vscode.window.activeTextEditor;
      if (editor) {
        const selection = editor.document.getText(editor.selection);
        if (selection && selection.trim().length > 0) {
          input = selection.trim();
        }
      }
      if (!input) {
        input = await vscode.window.showInputBox({
          prompt: 'Enter metadata name for impact analysis',
          placeHolder: 'e.g., Account.Industry, MyApexClass',
        });
      }
      if (!input) {
        return;
      }

      const report = impactAnalyzer.analyze(input);
      impactView.analyze(input);
      resultsView.clear();

      if (report.totalReferences === 0) {
        vscode.window.showInformationMessage(
          `No references found for "${input}" in the project.`
        );
      } else {
        vscode.window.showInformationMessage(
          `Found ${report.totalReferences} reference(s) to "${input}".`
        );
      }
    })
  );

  // 3. Field usage (context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand('sfSearch.fieldUsage', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      const selection = editor.document.getText(editor.selection);
      const word = selection || getWordAtCursor(editor);
      if (!word) {
        vscode.window.showWarningMessage('No text selected or word under cursor.');
        return;
      }

      const panel = SearchPanel.createOrShow(
        context.extensionUri,
        searchEngine,
        sfService
      );
      wireSearchPanel(panel);
      panel.triggerSearch(word);
    })
  );

  // 4. Object usage (context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand('sfSearch.objectUsage', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }

      const selection = editor.document.getText(editor.selection);
      const word = selection || getWordAtCursor(editor);
      if (!word) {
        vscode.window.showWarningMessage('No text selected or word under cursor.');
        return;
      }

      const panel = SearchPanel.createOrShow(
        context.extensionUri,
        searchEngine,
        sfService
      );
      wireSearchPanel(panel);
      panel.triggerSearch(word);
    })
  );

  // 5. Search word at cursor (editor context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand('sfSearch.searchFromEditor', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const word = getWordAtCursor(editor);
      if (!word) {
        vscode.window.showWarningMessage('No word found at cursor position.');
        return;
      }
      const panel = SearchPanel.createOrShow(
        context.extensionUri,
        searchEngine,
        sfService
      );
      wireSearchPanel(panel);
      panel.triggerSearch(word);
    })
  );

  // 6. Search selection (editor context menu)
  context.subscriptions.push(
    vscode.commands.registerCommand('sfSearch.searchSelection', () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        return;
      }
      const selection = editor.document.getText(editor.selection);
      if (!selection) {
        vscode.window.showWarningMessage('No text selected.');
        return;
      }
      const panel = SearchPanel.createOrShow(
        context.extensionUri,
        searchEngine,
        sfService
      );
      wireSearchPanel(panel);
      panel.triggerSearch(selection);
    })
  );

  // 7. Rebuild index
  context.subscriptions.push(
    vscode.commands.registerCommand('sfSearch.rebuildIndex', async () => {
      statusBarItem.text = '$(loading~spin) ImpactLens: Rebuilding…';
      outputChannel.appendLine('[ImpactLens] Rebuilding index…');
      try {
        await indexer.rebuildIndex();
        const count = indexer.documentCount;
        statusBarItem.text = `$(search) ImpactLens (${count} files)`;
        vscode.window.showInformationMessage(
          `ImpactLens index rebuilt: ${count} files indexed.`
        );
      } catch (err) {
        statusBarItem.text = '$(warning) ImpactLens: Error';
        vscode.window.showErrorMessage(`Failed to rebuild index: ${err}`);
      }
    })
  );

  // 8. Open result (used by tree view clicks)
  context.subscriptions.push(
    vscode.commands.registerCommand(
      'sfSearch.openResult',
      async (filePath: string, line: number) => {
        try {
          const uri = vscode.Uri.file(filePath);
          const doc = await vscode.workspace.openTextDocument(uri);
          const editor = await vscode.window.showTextDocument(doc, {
            preview: true,
          });
          const position = new vscode.Position(Math.max(0, line - 1), 0);
          editor.selection = new vscode.Selection(position, position);
          editor.revealRange(
            new vscode.Range(position, position),
            vscode.TextEditorRevealType.InCenter
          );
        } catch (err) {
          vscode.window.showErrorMessage(`Failed to open file: ${filePath}`);
        }
      }
    )
  );

  // 9. Analyze impact (used by CodeLens, Hover, and command palette)
  context.subscriptions.push(
    vscode.commands.registerCommand('sfSearch.analyzeImpact', async (name?: string) => {
      if (!name) {
        // Invoked from command palette — check selection or prompt
        const editor = vscode.window.activeTextEditor;
        if (editor) {
          const selection = editor.document.getText(editor.selection);
          if (selection && selection.trim().length > 0) {
            name = selection.trim();
          } else {
            const word = getWordAtCursor(editor);
            if (word) {
              name = word;
            }
          }
        }
        if (!name) {
          name = await vscode.window.showInputBox({
            prompt: 'Enter metadata name for impact analysis',
            placeHolder: 'e.g., Account.Industry, MyApexClass',
          });
        }
      }
      if (!name) {
        return;
      }
      impactView.analyze(name);
      const report = impactAnalyzer.analyze(name);
      vscode.window.showInformationMessage(
        `Impact: ${report.totalReferences} refs, risk=${report.riskLevel} (${report.riskScore}/100)`
      );
    })
  );

  // 10. Export impact report
  context.subscriptions.push(
    vscode.commands.registerCommand('sfSearch.exportImpact', async () => {
      const report = impactView.getLastReport();
      if (!report) {
        vscode.window.showWarningMessage('No impact report to export. Run an analysis first.');
        return;
      }

      const format = await vscode.window.showQuickPick(
        [
          { label: 'Markdown', value: ExportFormat.Markdown },
          { label: 'CSV', value: ExportFormat.CSV },
          { label: 'JSON', value: ExportFormat.JSON },
        ],
        { placeHolder: 'Select export format' }
      );

      if (!format) { return; }

      const content = impactAnalyzer.exportReport(report, format.value);
      const doc = await vscode.workspace.openTextDocument({ content, language: format.value === ExportFormat.JSON ? 'json' : format.value === ExportFormat.Markdown ? 'markdown' : 'csv' });
      await vscode.window.showTextDocument(doc);
    })
  );

  // 11. Export search results
  context.subscriptions.push(
    vscode.commands.registerCommand('sfSearch.exportResults', async () => {
      const results = resultsView.getResults();
      if (!results || results.length === 0) {
        vscode.window.showWarningMessage('No search results to export.');
        return;
      }

      const format = await vscode.window.showQuickPick(
        [
          { label: 'Markdown', value: ExportFormat.Markdown },
          { label: 'CSV', value: ExportFormat.CSV },
          { label: 'JSON', value: ExportFormat.JSON },
        ],
        { placeHolder: 'Select export format' }
      );

      if (!format) { return; }

      const content = searchEngine.exportResults(results, format.value);
      const doc = await vscode.workspace.openTextDocument({ content, language: format.value === ExportFormat.JSON ? 'json' : format.value === ExportFormat.Markdown ? 'markdown' : 'csv' });
      await vscode.window.showTextDocument(doc);
    })
  );

  // 12. Search history quick pick
  context.subscriptions.push(
    vscode.commands.registerCommand('sfSearch.searchHistory', async () => {
      const history = searchEngine.getHistory();
      if (history.length === 0) {
        vscode.window.showInformationMessage('No search history yet.');
        return;
      }

      const items = history.map(h => ({
        label: h.query,
        description: `${h.resultCount} results`,
        detail: new Date(h.timestamp).toLocaleString(),
      }));

      const selected = await vscode.window.showQuickPick(items, {
        placeHolder: 'Select a previous search',
      });

      if (selected) {
        const panel = SearchPanel.createOrShow(
          context.extensionUri,
          searchEngine,
          sfService
        );
        wireSearchPanel(panel);
        panel.triggerSearch(selected.label);
      }
    })
  );

  // ─── Initialize Indexer ────────────────────────────────────────────

  indexer.onIndexUpdated(() => {
    const count = indexer.documentCount;
    statusBarItem.text = `$(search) ImpactLens (${count} files)`;
  });

  try {
    await indexer.initialize();
    const count = indexer.documentCount;
    statusBarItem.text = `$(search) ImpactLens (${count} files)`;
    outputChannel.appendLine(`[ImpactLens] Activated. ${count} files indexed.`);
  } catch (err) {
    statusBarItem.text = '$(warning) ImpactLens: Error';
    outputChannel.appendLine(`[ImpactLens] Initialization failed: ${err}`);
    vscode.window.showErrorMessage(
      `ImpactLens initialization failed: ${err}. Try "ImpactLens: Rebuild Index".`
    );
  }

  // Clean up
  context.subscriptions.push(outputChannel);
}

/**
 * Extension deactivation.
 */
export function deactivate(): void {
  outputChannel?.appendLine('[ImpactLens] Extension deactivated.');
}

/**
 * Get the word under the cursor in the active editor.
 */
function getWordAtCursor(editor: vscode.TextEditor): string {
  const position = editor.selection.active;
  const range = editor.document.getWordRangeAtPosition(
    position,
    /[\w.]+/
  );
  return range ? editor.document.getText(range) : '';
}
