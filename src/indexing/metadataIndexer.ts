import * as vscode from 'vscode';
import * as path from 'path';
import * as nodeFs from 'fs';
import { Worker } from 'worker_threads';
import MiniSearch from 'minisearch';
import {
  MetadataType,
  IndexDocument,
  ReferenceEntry,
  ParsedFile,
  SerializedIndex,
  WorkerMessageType,
} from '../models/searchResult';
import { parseFile, classifyFile } from './fileParser';
import { indexTokenize, preciseTokens } from './tokenize';

// Bumped to 3: reference-graph matching semantics changed (precise-by-default).
const INDEX_VERSION = 3;
const INDEX_FILE = 'search-index.json';

/** Per-glob cap passed to vscode.workspace.findFiles. */
const MAX_FILES_PER_GLOB = 50000;

/** Debounce window (ms) for coalescing index persistence writes. */
const PERSIST_DEBOUNCE_MS = 2000;

/**
 * Glob patterns for Salesforce metadata files.
 */
const SF_FILE_GLOBS: Array<{ pattern: string; type?: MetadataType }> = [
  { pattern: '**/*.cls', type: MetadataType.ApexClass },
  { pattern: '**/*.trigger', type: MetadataType.ApexTrigger },
  { pattern: '**/lwc/**/*.js', type: MetadataType.LWC },
  { pattern: '**/lwc/**/*.html', type: MetadataType.LWC },
  { pattern: '**/aura/**/*.cmp', type: MetadataType.Aura },
  { pattern: '**/aura/**/*.js', type: MetadataType.Aura },
  { pattern: '**/aura/**/*.app', type: MetadataType.Aura },
  { pattern: '**/*.flow-meta.xml', type: MetadataType.Flow },
  { pattern: '**/objects/**/*.object-meta.xml', type: MetadataType.CustomObject },
  { pattern: '**/objects/**/*.field-meta.xml', type: MetadataType.CustomField },
  { pattern: '**/objects/**/validationRules/*.xml' },
  { pattern: '**/objects/**/recordTypes/*.xml', type: MetadataType.RecordType },
  { pattern: '**/*.permissionset-meta.xml', type: MetadataType.PermissionSet },
  { pattern: '**/*.profile-meta.xml', type: MetadataType.Profile },
  { pattern: '**/*.layout-meta.xml', type: MetadataType.Layout },
  { pattern: '**/*.labels-meta.xml', type: MetadataType.CustomLabel },
  { pattern: '**/*.md-meta.xml', type: MetadataType.CustomMetadata },
  { pattern: '**/*.flexipage-meta.xml', type: MetadataType.FlexiPage },
  { pattern: '**/*.page', type: MetadataType.VisualforcePage },
  { pattern: '**/*.component', type: MetadataType.VisualforceComponent },
  { pattern: '**/*.email-meta.xml', type: MetadataType.EmailTemplate },
  { pattern: '**/*.approvalProcess-meta.xml', type: MetadataType.ApprovalProcess },
  { pattern: '**/*.sharingRules-meta.xml', type: MetadataType.SharingRule },
  { pattern: '**/*.quickAction-meta.xml', type: MetadataType.QuickAction },
  { pattern: '**/*.globalValueSet-meta.xml', type: MetadataType.GlobalValueSet },
  { pattern: '**/*.customSetting-meta.xml', type: MetadataType.CustomSetting },
];

/**
 * The core metadata indexing engine.
 * Builds and maintains a full-text search index + reference graph.
 */
export class MetadataIndexer {
  private searchIndex: MiniSearch<IndexDocument>;
  private referenceGraph: Map<string, ReferenceEntry[]> = new Map();
  private fileMtimes: Map<string, number> = new Map();
  private indexedDocuments: Map<string, IndexDocument> = new Map();
  private fileWatchers: vscode.FileSystemWatcher[] = [];
  private debounceTimers: Map<string, ReturnType<typeof setTimeout>> = new Map();
  private isIndexing = false;
  private context: vscode.ExtensionContext;
  private outputChannel: vscode.OutputChannel;

  // ── Derived lookup indexes (in-memory only; rebuilt lazily, not persisted) ──
  /** lowercased keyword -> aggregated reference entries (O(1) exact lookup). */
  private exactIndex: Map<string, ReferenceEntry[]> = new Map();
  /** precise token -> set of lowercased keywords containing that token. */
  private tokenIndex: Map<string, Set<string>> = new Map();
  /** When true, the derived indexes are stale and rebuilt on next lookup. */
  private derivedDirty = true;

  /** Debounced-persist handle and one-shot truncation warning guard. */
  private persistTimer: ReturnType<typeof setTimeout> | undefined;
  private warnedTruncation = false;

  private readonly onDidUpdateIndex = new vscode.EventEmitter<void>();
  public readonly onIndexUpdated = this.onDidUpdateIndex.event;

  constructor(context: vscode.ExtensionContext, outputChannel: vscode.OutputChannel) {
    this.context = context;
    this.outputChannel = outputChannel;
    this.searchIndex = this.createSearchIndex();
  }

  /**
   * Create a new MiniSearch index with Salesforce-optimized configuration.
   */
  private createSearchIndex(): MiniSearch<IndexDocument> {
    return new MiniSearch<IndexDocument>({
      fields: ['name', 'type', 'content', 'references', 'methods', 'objectName'],
      storeFields: ['name', 'type', 'filePath', 'objectName', 'methods'],
      idField: 'id',
      searchOptions: {
        boost: { name: 3, references: 2.5, methods: 2, content: 1 },
        fuzzy: this.getFuzzyTolerance(),
        prefix: true,
      },
      tokenize: indexTokenize,
    });
  }

  private getFuzzyTolerance(): number {
    const config = vscode.workspace.getConfiguration('sfSearch');
    return config.get<number>('fuzzyTolerance', 0.2);
  }

  private getMaxFileSize(): number {
    const config = vscode.workspace.getConfiguration('sfSearch');
    return config.get<number>('maxFileSize', 1048576);
  }

  private getDebounceDelay(): number {
    const config = vscode.workspace.getConfiguration('sfSearch');
    return config.get<number>('debounceDelay', 300);
  }

  private getExcludePatterns(): string[] {
    const config = vscode.workspace.getConfiguration('sfSearch');
    return config.get<string[]>('excludePatterns', ['**/node_modules/**', '**/.sfdx/**', '**/.sf/**']);
  }

  // ─────────────────────────────────────────────────────────────────
  // Public API
  // ─────────────────────────────────────────────────────────────────

  /**
   * Initialize indexing: load cached index or build from scratch.
   */
  async initialize(): Promise<void> {
    const loaded = await this.loadCachedIndex();
    if (!loaded) {
      await this.buildFullIndex();
    } else {
      await this.incrementalUpdate();
    }
    this.setupFileWatchers();
  }

  /**
   * Rebuild the index from scratch.
   */
  async rebuildIndex(): Promise<void> {
    this.searchIndex = this.createSearchIndex();
    this.referenceGraph.clear();
    this.fileMtimes.clear();
    this.indexedDocuments.clear();
    this.derivedDirty = true;
    await this.buildFullIndex();
  }

  /**
   * Get the MiniSearch index for querying.
   */
  getSearchIndex(): MiniSearch<IndexDocument> {
    return this.searchIndex;
  }

  // ─────────────────────────────────────────────────────────────────
  // Fast lookup API (backed by derived indexes)
  // ─────────────────────────────────────────────────────────────────

  /**
   * Rebuild the derived exact/token indexes from the reference graph.
   * Runs at most once per batch of mutations (guarded by `derivedDirty`).
   */
  private ensureDerived(): void {
    if (!this.derivedDirty) {
      return;
    }
    this.exactIndex.clear();
    this.tokenIndex.clear();

    for (const [keyword, entries] of this.referenceGraph.entries()) {
      const lower = keyword.toLowerCase();
      const bucket = this.exactIndex.get(lower);
      if (bucket) {
        bucket.push(...entries);
      } else {
        this.exactIndex.set(lower, [...entries]);
      }
      for (const token of preciseTokens(keyword)) {
        let set = this.tokenIndex.get(token);
        if (!set) {
          set = new Set<string>();
          this.tokenIndex.set(token, set);
        }
        set.add(lower);
      }
    }
    this.derivedDirty = false;
  }

  /**
   * Exact (case-insensitive) keyword lookup. O(1).
   */
  lookupExact(name: string): ReferenceEntry[] {
    this.ensureDerived();
    return this.exactIndex.get(name.toLowerCase()) ?? [];
  }

  /**
   * Precise lookup: matches the whole identifier or any dot/underscore
   * segment of a keyword (never camelCase). "Account" matches `Account` and
   * `Account.Name` but not `AccountService`. Backed by the token index.
   */
  lookupPrecise(name: string): ReferenceEntry[] {
    this.ensureDerived();
    const query = name.toLowerCase().trim();
    if (!query) {
      return [];
    }

    const collect = (token: string): ReferenceEntry[] => {
      const keywords = this.tokenIndex.get(token);
      if (!keywords) {
        return [];
      }
      const out: ReferenceEntry[] = [];
      for (const keyword of keywords) {
        const entries = this.exactIndex.get(keyword);
        if (entries) {
          out.push(...entries);
        }
      }
      return out;
    };

    let results = collect(query);
    // Fall back to the trailing field segment for dotted queries
    // (e.g. "Account.Status__c" when only "Status__c" is indexed).
    if (results.length === 0 && query.includes('.')) {
      const last = query.split('.').pop() ?? '';
      if (last.length >= 2) {
        results = collect(last);
      }
    }
    return results;
  }

  /**
   * Broad (substring) lookup — opt-in, used by the panel's "contains" mode.
   * Scans unique keywords; only invoked when the user explicitly broadens.
   */
  lookupBroad(name: string): ReferenceEntry[] {
    this.ensureDerived();
    const query = name.toLowerCase().trim();
    if (!query) {
      return [];
    }
    const out: ReferenceEntry[] = [];
    for (const [keyword, entries] of this.exactIndex.entries()) {
      if (keyword.includes(query)) {
        out.push(...entries);
      }
    }
    return out;
  }

  /**
   * Count precise references to an identifier (used by CodeLens/Hover).
   */
  countReferences(name: string): number {
    return this.lookupPrecise(name).length;
  }

  /**
   * Check if indexing is in progress.
   */
  get indexing(): boolean {
    return this.isIndexing;
  }

  /**
   * Get count of indexed documents.
   */
  get documentCount(): number {
    return this.indexedDocuments.size;
  }

  /**
   * Dispose all watchers and timers.
   */
  dispose(): void {
    for (const watcher of this.fileWatchers) {
      watcher.dispose();
    }
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    // Flush any pending debounced persist so the last edits aren't lost.
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
      this.persistTimer = undefined;
      void this.persistIndex();
    }
    this.onDidUpdateIndex.dispose();
  }

  // ─────────────────────────────────────────────────────────────────
  // Full index build
  // ─────────────────────────────────────────────────────────────────

  /**
   * Build the full search index using a worker thread.
   */
  private async buildFullIndex(): Promise<void> {
    if (this.isIndexing) {
      this.outputChannel.appendLine('[Indexer] Index build already in progress.');
      return;
    }

    this.isIndexing = true;
    const startTime = Date.now();
    this.outputChannel.appendLine('[Indexer] Starting full index build...');

    await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: 'ImpactLens: Indexing metadata...',
        cancellable: true,
      },
      async (progress, token) => {
        try {
          // 1. Discover all files
          const files = await this.discoverFiles();
          this.outputChannel.appendLine(`[Indexer] Found ${files.length} metadata files.`);

          if (files.length === 0) {
            this.outputChannel.appendLine('[Indexer] No Salesforce metadata files found.');
            return;
          }

          progress.report({ message: `Found ${files.length} files. Parsing...`, increment: 10 });

          // 2. Parse files using worker thread
          const parsedFiles = await this.parseFilesWithWorker(files, progress, token);

          if (token.isCancellationRequested) {
            this.outputChannel.appendLine('[Indexer] Index build cancelled.');
            return;
          }

          progress.report({ message: 'Building search index...', increment: 20 });

          // 3. Build index from parsed results
          this.buildIndexFromParsedFiles(parsedFiles);

          // 4. Persist to disk
          await this.persistIndex();

          const elapsed = Date.now() - startTime;
          const msg = `[Indexer] Index built: ${this.indexedDocuments.size} files, ${this.referenceGraph.size} references in ${elapsed}ms.`;
          this.outputChannel.appendLine(msg);

          progress.report({ message: 'Index complete!', increment: 100 });
          this.onDidUpdateIndex.fire();

        } catch (err: unknown) {
          const message = err instanceof Error ? err.message : String(err);
          this.outputChannel.appendLine(`[Indexer] Error building index: ${message}`);
          vscode.window.showErrorMessage(`ImpactLens: Indexing failed: ${message}`);
        } finally {
          this.isIndexing = false;
        }
      }
    );
  }

  /**
   * Discover all Salesforce metadata files in the workspace.
   */
  private async discoverFiles(): Promise<Array<{ path: string; metadataType: MetadataType }>> {
    const excludePattern = `{${this.getExcludePatterns().join(',')}}`;
    const allFiles: Array<{ path: string; metadataType: MetadataType }> = [];
    const seen = new Set<string>();

    let truncated = false;
    for (const glob of SF_FILE_GLOBS) {
      const uris = await vscode.workspace.findFiles(glob.pattern, excludePattern, MAX_FILES_PER_GLOB);
      if (uris.length >= MAX_FILES_PER_GLOB) {
        truncated = true;
      }
      for (const uri of uris) {
        if (!seen.has(uri.fsPath)) {
          seen.add(uri.fsPath);
          allFiles.push({
            path: uri.fsPath,
            metadataType: glob.type ?? classifyFile(uri.fsPath),
          });
        }
      }
    }

    if (truncated && !this.warnedTruncation) {
      this.warnedTruncation = true;
      const msg = `[Indexer] File discovery hit the ${MAX_FILES_PER_GLOB}-file cap for at least one pattern; the index may be incomplete.`;
      this.outputChannel.appendLine(msg);
      vscode.window.showWarningMessage(
        `ImpactLens: this project exceeds ${MAX_FILES_PER_GLOB} files for some metadata types. Search and impact results may be incomplete.`
      );
    }

    return allFiles;
  }

  /**
   * Parse files using a dedicated worker thread.
   */
  private parseFilesWithWorker(
    files: Array<{ path: string; metadataType: MetadataType }>,
    progress: vscode.Progress<{ message?: string; increment?: number }>,
    token: vscode.CancellationToken,
  ): Promise<ParsedFile[]> {
    return new Promise((resolve, _reject) => {
      const workerPath = path.join(this.context.extensionPath, 'dist', 'indexWorker.js');

      let worker: Worker;
      try {
        worker = new Worker(workerPath, {
          workerData: {
            files: files.map(f => ({ path: f.path, metadataType: f.metadataType })),
            maxFileSize: this.getMaxFileSize(),
          },
        });
      } catch {
        // Fallback to main-thread parsing if worker fails
        this.outputChannel.appendLine('[Indexer] Worker thread unavailable, falling back to main thread parsing.');
        resolve(this.parseFilesMainThread(files));
        return;
      }

      token.onCancellationRequested(() => {
        worker.terminate();
        resolve([]);
      });

      worker.on('message', (msg: { type: WorkerMessageType; payload?: unknown }) => {
        if (msg.type === WorkerMessageType.Progress) {
          const p = msg.payload as { processed: number; total: number };
          const pct = Math.round((p.processed / p.total) * 60);
          progress.report({
            message: `Parsing... ${p.processed}/${p.total} files`,
            increment: pct > 0 ? 1 : 0,
          });
        } else if (msg.type === WorkerMessageType.ParseComplete) {
          const result = msg.payload as { parsed: ParsedFile[]; errors: Array<{ file: string; error: string }> };
          for (const err of result.errors) {
            this.outputChannel.appendLine(`[Indexer] Parse error in ${err.file}: ${err.error}`);
          }
          resolve(result.parsed);
        }
      });

      worker.on('error', (err) => {
        this.outputChannel.appendLine(`[Indexer] Worker error: ${err.message}`);
        // Fallback to main thread
        resolve(this.parseFilesMainThread(files));
      });

      worker.on('exit', (code) => {
        if (code !== 0) {
          this.outputChannel.appendLine(`[Indexer] Worker exited with code ${code}`);
        }
      });
    });
  }

  /**
   * Fallback: parse files on the main thread.
   */
  private async parseFilesMainThread(
    files: Array<{ path: string; metadataType: MetadataType }>,
  ): Promise<ParsedFile[]> {
    const results: ParsedFile[] = [];
    const maxFileSize = this.getMaxFileSize();

    for (const entry of files) {
      try {
        const uri = vscode.Uri.file(entry.path);
        const stat = await vscode.workspace.fs.stat(uri);
        if (stat.size > maxFileSize) { continue; }

        const contentBytes = await vscode.workspace.fs.readFile(uri);
        const content = Buffer.from(contentBytes).toString('utf-8');
        const parsed = parseFile(entry.path, content, entry.metadataType);
        results.push({ ...parsed, content: '' });
      } catch {
        // Skip files that can't be read
      }
    }

    return results;
  }

  /**
   * Build search index and reference graph from parsed files.
   */
  private buildIndexFromParsedFiles(parsedFiles: ParsedFile[]): void {
    const documents: IndexDocument[] = [];

    for (const parsed of parsedFiles) {
      const doc: IndexDocument = {
        id: parsed.filePath,
        name: parsed.fileName,
        type: parsed.metadataType,
        objectName: parsed.objectName,
        content: '',
        references: parsed.references.join(' '),
        methods: parsed.methods.join(' '),
        filePath: parsed.filePath,
      };

      documents.push(doc);
      this.indexedDocuments.set(parsed.filePath, doc);

      // Build reference graph
      for (const lineRef of parsed.lineReferences) {
        const entry: ReferenceEntry = {
          keyword: lineRef.keyword,
          filePath: parsed.filePath,
          fileName: parsed.fileName,
          line: lineRef.line,
          column: lineRef.column,
          metadataType: parsed.metadataType,
          objectName: parsed.objectName,
          snippet: lineRef.snippet,
        };

        const existing = this.referenceGraph.get(lineRef.keyword) ?? [];
        existing.push(entry);
        this.referenceGraph.set(lineRef.keyword, existing);
      }

      // Track file mtime
      try {
        const stat = nodeFs.statSync(parsed.filePath);
        this.fileMtimes.set(parsed.filePath, stat.mtimeMs);
      } catch {
        // Non-critical
      }
    }

    // Add all documents to MiniSearch
    this.searchIndex.addAll(documents);

    // Derived lookup indexes are now stale.
    this.derivedDirty = true;
  }

  // ─────────────────────────────────────────────────────────────────
  // Incremental indexing
  // ─────────────────────────────────────────────────────────────────

  /**
   * Incrementally update the index with changed files.
   */
  private async incrementalUpdate(): Promise<void> {
    const files = await this.discoverFiles();
    const staleFiles: Array<{ path: string; metadataType: MetadataType }> = [];

    for (const file of files) {
      try {
        const stat = nodeFs.statSync(file.path);
        const cachedMtime = this.fileMtimes.get(file.path);
        if (!cachedMtime || stat.mtimeMs > cachedMtime) {
          staleFiles.push(file);
        }
      } catch {
        // File may have been deleted
      }
    }

    if (staleFiles.length === 0) {
      this.outputChannel.appendLine('[Indexer] Index is up to date.');
      return;
    }

    this.outputChannel.appendLine(`[Indexer] Incrementally updating ${staleFiles.length} stale files.`);

    for (const file of staleFiles) {
      this.removeFileFromIndex(file.path);
    }

    const parsedFiles = await this.parseFilesMainThread(staleFiles);
    this.buildIndexFromParsedFiles(parsedFiles);
    await this.persistIndex();
    this.onDidUpdateIndex.fire();
  }

  /**
   * Update a single file in the index.
   */
  async updateFile(filePath: string): Promise<void> {
    try {
      const uri = vscode.Uri.file(filePath);
      const stat = await vscode.workspace.fs.stat(uri);
      if (stat.size > this.getMaxFileSize()) { return; }

      const contentBytes = await vscode.workspace.fs.readFile(uri);
      const content = Buffer.from(contentBytes).toString('utf-8');
      const metadataType = classifyFile(filePath);

      this.removeFileFromIndex(filePath);

      const parsed = parseFile(filePath, content, metadataType);
      this.buildIndexFromParsedFiles([{ ...parsed, content: '' }]);

      this.outputChannel.appendLine(`[Indexer] Updated index for: ${path.basename(filePath)}`);
      // Coalesce rapid saves into a single debounced disk write.
      this.schedulePersist();
      this.onDidUpdateIndex.fire();
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(`[Indexer] Error updating ${filePath}: ${message}`);
    }
  }

  /**
   * Remove a file from the index.
   */
  removeFileFromIndex(filePath: string): void {
    const existingDoc = this.indexedDocuments.get(filePath);
    if (existingDoc) {
      try {
        this.searchIndex.remove(existingDoc);
      } catch {
        // Document might not be in the index
      }
      this.indexedDocuments.delete(filePath);
    }

    for (const [keyword, entries] of this.referenceGraph.entries()) {
      const filtered = entries.filter(e => e.filePath !== filePath);
      if (filtered.length === 0) {
        this.referenceGraph.delete(keyword);
      } else {
        this.referenceGraph.set(keyword, filtered);
      }
    }

    this.fileMtimes.delete(filePath);
    this.derivedDirty = true;
  }

  // ─────────────────────────────────────────────────────────────────
  // File watchers
  // ─────────────────────────────────────────────────────────────────

  private setupFileWatchers(): void {
    const patterns = [
      '**/*.cls', '**/*.trigger',
      '**/lwc/**/*.js', '**/lwc/**/*.html',
      '**/aura/**/*.cmp', '**/aura/**/*.js',
      '**/*.flow-meta.xml',
      '**/objects/**/*.xml',
      '**/*.permissionset-meta.xml',
      '**/*.profile-meta.xml',
      '**/*.layout-meta.xml',
      '**/*.page',
    ];

    for (const pattern of patterns) {
      const watcher = vscode.workspace.createFileSystemWatcher(pattern);

      watcher.onDidChange((uri) => this.debouncedUpdate(uri.fsPath));
      watcher.onDidCreate((uri) => this.debouncedUpdate(uri.fsPath));
      watcher.onDidDelete((uri) => {
        this.removeFileFromIndex(uri.fsPath);
        this.onDidUpdateIndex.fire();
      });

      this.fileWatchers.push(watcher);
    }

    this.outputChannel.appendLine('[Indexer] File watchers active.');
  }

  private debouncedUpdate(filePath: string): void {
    const existing = this.debounceTimers.get(filePath);
    if (existing) { clearTimeout(existing); }

    const timer = setTimeout(() => {
      this.debounceTimers.delete(filePath);
      this.updateFile(filePath);
    }, this.getDebounceDelay());

    this.debounceTimers.set(filePath, timer);
  }

  // ─────────────────────────────────────────────────────────────────
  // Persistence
  // ─────────────────────────────────────────────────────────────────

  /**
   * Coalesce frequent incremental updates into a single debounced disk write,
   * avoiding repeated multi-MB serializations on rapid file saves.
   */
  private schedulePersist(): void {
    if (this.persistTimer) {
      clearTimeout(this.persistTimer);
    }
    this.persistTimer = setTimeout(() => {
      this.persistTimer = undefined;
      void this.persistIndex();
    }, PERSIST_DEBOUNCE_MS);
  }

  private async persistIndex(): Promise<void> {
    try {
      const data: SerializedIndex = {
        version: INDEX_VERSION,
        timestamp: Date.now(),
        documents: Array.from(this.indexedDocuments.values()),
        referenceGraph: Object.fromEntries(
          Array.from(this.referenceGraph.entries()),
        ),
        fileMtimes: Object.fromEntries(
          Array.from(this.fileMtimes.entries()),
        ),
      };

      const storageUri = this.context.globalStorageUri;
      await vscode.workspace.fs.createDirectory(storageUri);

      const indexUri = vscode.Uri.joinPath(storageUri, INDEX_FILE);
      const json = JSON.stringify(data);
      await vscode.workspace.fs.writeFile(indexUri, Buffer.from(json, 'utf-8'));

      this.outputChannel.appendLine(`[Indexer] Index persisted (${(json.length / 1024).toFixed(1)} KB).`);
    } catch (err: unknown) {
      const message = err instanceof Error ? err.message : String(err);
      this.outputChannel.appendLine(`[Indexer] Error persisting index: ${message}`);
    }
  }

  private async loadCachedIndex(): Promise<boolean> {
    try {
      const indexUri = vscode.Uri.joinPath(this.context.globalStorageUri, INDEX_FILE);
      const contentBytes = await vscode.workspace.fs.readFile(indexUri);
      const json = Buffer.from(contentBytes).toString('utf-8');
      const data: SerializedIndex = JSON.parse(json);

      if (data.version !== INDEX_VERSION) {
        this.outputChannel.appendLine('[Indexer] Index version mismatch, rebuilding.');
        return false;
      }

      for (const doc of data.documents) {
        this.indexedDocuments.set(doc.id, doc);
      }

      this.searchIndex.addAll(data.documents);

      for (const [keyword, entries] of Object.entries(data.referenceGraph)) {
        this.referenceGraph.set(keyword, entries);
      }

      for (const [file, mtime] of Object.entries(data.fileMtimes)) {
        this.fileMtimes.set(file, mtime);
      }

      this.derivedDirty = true;
      this.outputChannel.appendLine(
        `[Indexer] Loaded cached index: ${data.documents.length} files, ${Object.keys(data.referenceGraph).length} references.`
      );
      return true;
    } catch {
      return false;
    }
  }
}
