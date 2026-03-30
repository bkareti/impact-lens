import * as vscode from 'vscode';
import MiniSearch, { SearchResult as MiniSearchResult } from 'minisearch';
import {
  MetadataType,
  SearchResult,
  IndexDocument,
  ReferenceEntry,
  ExportFormat,
  SearchHistoryEntry,
} from '../models/searchResult';
import { MetadataIndexer } from '../indexing/metadataIndexer';

/**
 * Metadata type filter set used by the UI.
 */
export interface SearchFilters {
  apex?: boolean;
  lwc?: boolean;
  aura?: boolean;
  flows?: boolean;
  objects?: boolean;
  metadata?: boolean;
  validationRules?: boolean;
  permissions?: boolean;
  permissionSets?: boolean;
  profiles?: boolean;
  layouts?: boolean;
  labels?: boolean;
  all?: boolean;
}

/**
 * Search options for advanced queries.
 */
export interface SearchOptions {
  query: string;
  filters?: SearchFilters;
  maxResults?: number;
  exactMatch?: boolean;
}

/**
 * The metadata-type groups for filtering.
 */
const FILTER_GROUPS: Record<string, MetadataType[]> = {
  apex: [MetadataType.ApexClass, MetadataType.ApexTrigger],
  lwc: [MetadataType.LWC],
  aura: [MetadataType.Aura],
  flows: [MetadataType.Flow],
  objects: [
    MetadataType.CustomObject,
    MetadataType.CustomField,
    MetadataType.CustomMetadata,
    MetadataType.PlatformEvent,
    MetadataType.CustomSetting,
    MetadataType.GlobalValueSet,
    MetadataType.RecordType,
  ],
  metadata: [
    MetadataType.CustomObject,
    MetadataType.CustomField,
    MetadataType.CustomMetadata,
    MetadataType.CustomLabel,
    MetadataType.PlatformEvent,
    MetadataType.NamedCredential,
    MetadataType.EmailTemplate,
    MetadataType.FlexiPage,
    MetadataType.StaticResource,
    MetadataType.CustomSetting,
    MetadataType.GlobalValueSet,
    MetadataType.RecordType,
    MetadataType.QuickAction,
  ],
  validationRules: [MetadataType.ValidationRule, MetadataType.WorkflowRule, MetadataType.ApprovalProcess],
  permissions: [MetadataType.PermissionSet, MetadataType.Profile],
  permissionSets: [MetadataType.PermissionSet],
  profiles: [MetadataType.Profile],
  layouts: [MetadataType.Layout],
  labels: [MetadataType.CustomLabel],
  automation: [MetadataType.Flow, MetadataType.WorkflowRule, MetadataType.ApprovalProcess, MetadataType.SharingRule],
  ui: [MetadataType.Layout, MetadataType.FlexiPage, MetadataType.QuickAction, MetadataType.VisualforcePage, MetadataType.VisualforceComponent],
};

/** Maximum search history entries to keep. */
const MAX_HISTORY_ENTRIES = 50;

/**
 * High-performance search engine backed by MiniSearch + reference graph.
 */
export class SearchEngine {
  private indexer: MetadataIndexer;
  private outputChannel: vscode.OutputChannel;

  constructor(indexer: MetadataIndexer, outputChannel: vscode.OutputChannel) {
    this.indexer = indexer;
    this.outputChannel = outputChannel;
  }

  /**
   * Perform a search query against the index.
   */
  search(options: SearchOptions): SearchResult[] {
    const { query, filters, maxResults = 200, exactMatch = false } = options;

    if (!query || query.trim().length === 0) {
      return [];
    }

    const startTime = Date.now();
    const results: SearchResult[] = [];

    // Strategy 1: Direct reference graph lookup (fastest, most precise)
    const graphResults = this.searchReferenceGraph(query, filters, exactMatch);
    results.push(...graphResults);

    // Strategy 2: Full-text search via MiniSearch
    const textResults = this.searchFullText(query, filters, exactMatch);

    // Merge, deduplicate by file+line
    const seen = new Set<string>();
    for (const r of results) {
      seen.add(`${r.filePath}:${r.line}`);
    }
    for (const r of textResults) {
      const key = `${r.filePath}:${r.line}`;
      if (!seen.has(key)) {
        seen.add(key);
        results.push(r);
      }
    }

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);

    // Limit results
    const limited = results.slice(0, maxResults);

    const elapsed = Date.now() - startTime;
    this.outputChannel.appendLine(
      `[Search] Query "${query}" returned ${limited.length} results in ${elapsed}ms.`
    );

    return limited;
  }

  /**
   * Search the reference graph for keyword matches.
   * Uses **case-insensitive literal string containment** on the original keyword text.
   * - exactMatch: only exact (case-insensitive) keyword equality.
   * - normal: the query must appear as a literal substring within the keyword.
   *   "getContacts" matches "getContactsList" but NOT "get_Contacts" or "get_Contact".
   */
  private searchReferenceGraph(query: string, filters?: SearchFilters, exactMatch: boolean = false): SearchResult[] {
    const graph = this.indexer.getReferenceGraph();
    const results: SearchResult[] = [];
    const allowedTypes = this.resolveFilters(filters);
    const queryLower = query.toLowerCase();

    for (const [keyword, entries] of graph.entries()) {
      const keyLower = keyword.toLowerCase();

      let isMatch: boolean;
      let relevance: number;

      if (exactMatch) {
        // Exact mode: only identical keywords match (case-insensitive)
        isMatch = keyLower === queryLower;
        relevance = 100;
      } else {
        // Normal mode: case-insensitive literal string contains
        // The query must appear as-is within the keyword.
        // e.g. query "getContacts" matches keyword "getContactsList" ✓
        //      query "getContacts" does NOT match "get_Contacts" ✗
        //      query "Account" matches keyword "AccountService" ✓
        if (keyLower === queryLower) {
          isMatch = true;
          relevance = 100;
        } else if (keyLower.includes(queryLower)) {
          isMatch = true;
          relevance = 50;
        } else {
          isMatch = false;
          relevance = 0;
        }
      }

      if (!isMatch) { continue; }

      for (const entry of entries) {
        if (allowedTypes && !allowedTypes.has(entry.metadataType)) {
          continue;
        }

        results.push({
          keyword: entry.keyword,
          filePath: entry.filePath,
          fileName: entry.fileName,
          metadataType: entry.metadataType,
          objectName: entry.objectName,
          line: entry.line,
          column: entry.column,
          snippet: entry.snippet,
          score: relevance,
        });
      }
    }

    return results;
  }

  /**
   * Full-text search via MiniSearch.
   */
  private searchFullText(query: string, filters?: SearchFilters, exactMatch: boolean = false): SearchResult[] {
    const searchIndex = this.indexer.getSearchIndex();
    const allowedTypes = this.resolveFilters(filters);

    const searchOptions: Parameters<typeof searchIndex.search>[1] = {
      prefix: !exactMatch,
      fuzzy: exactMatch ? false : undefined,
      boost: { name: 3, references: 2.5, methods: 2 },
      combineWith: 'AND',
      // Always keep the search query as a single token so "getContacts" is NOT
      // split into ["get", "contacts"] (which would match "get_Contacts" etc.).
      // The index tokenizer already stored sub-tokens; searching with the whole
      // query still matches via prefix on the full token.
      tokenize: (text: string) => [text.toLowerCase()],
    };

    if (allowedTypes) {
      searchOptions.filter = (result: MiniSearchResult) => {
        return allowedTypes.has(result.type as MetadataType);
      };
    }

    const miniResults = searchIndex.search(query, searchOptions);

    return miniResults.map((r: MiniSearchResult) => ({
      keyword: query,
      filePath: (r as unknown as Record<string, unknown>).filePath as string ?? r.id as string,
      fileName: (r as unknown as Record<string, unknown>).name as string ?? '',
      metadataType: ((r as unknown as Record<string, unknown>).type as MetadataType) ?? MetadataType.Unknown,
      objectName: (r as unknown as Record<string, unknown>).objectName as string ?? '',
      line: 0,
      column: 0,
      snippet: '',
      score: r.score,
    }));
  }

  /**
   * Resolve filter flags into a set of allowed MetadataTypes.
   */
  private resolveFilters(filters?: SearchFilters): Set<MetadataType> | null {
    if (!filters || filters.all) {
      return null;
    }

    const allowed = new Set<MetadataType>();
    for (const [filterKey, types] of Object.entries(FILTER_GROUPS)) {
      if ((filters as Record<string, boolean | undefined>)[filterKey]) {
        for (const t of types) {
          allowed.add(t);
        }
      }
    }

    return allowed.size > 0 ? allowed : null;
  }

  /**
   * Search for all usages of a specific field API name.
   */
  searchFieldUsage(fieldName: string): SearchResult[] {
    return this.search({
      query: fieldName,
      filters: { all: true },
      maxResults: 500,
    });
  }

  /**
   * Search for all usages of a specific object API name.
   */
  searchObjectUsage(objectName: string): SearchResult[] {
    return this.search({
      query: objectName,
      filters: { all: true },
      maxResults: 500,
    });
  }

  // ── Search History ──────────────────────────────────────────────────────

  private searchHistory: SearchHistoryEntry[] = [];

  /**
   * Record a search query in the history.
   */
  addToHistory(query: string, resultCount: number, filters?: SearchFilters): void {
    const entry: SearchHistoryEntry = {
      query,
      timestamp: Date.now(),
      resultCount,
      pinned: false,
      filters: filters as Record<string, boolean | undefined>,
    };

    // Remove duplicate if same query exists
    this.searchHistory = this.searchHistory.filter(h => h.query !== query);
    this.searchHistory.unshift(entry);

    // Trim to max size
    if (this.searchHistory.length > MAX_HISTORY_ENTRIES) {
      this.searchHistory = this.searchHistory.slice(0, MAX_HISTORY_ENTRIES);
    }
  }

  /**
   * Get the search history (most recent first).
   */
  getHistory(): SearchHistoryEntry[] {
    return [...this.searchHistory];
  }

  /**
   * Clear all search history.
   */
  clearHistory(): void {
    this.searchHistory = [];
  }

  // ── Export ──────────────────────────────────────────────────────────────

  /**
   * Export search results in the specified format.
   */
  exportResults(results: SearchResult[], format: ExportFormat): string {
    switch (format) {
      case ExportFormat.CSV:
        return this.exportCsv(results);
      case ExportFormat.JSON:
        return this.exportJson(results);
      case ExportFormat.Markdown:
        return this.exportMarkdown(results);
      default:
        return this.exportCsv(results);
    }
  }

  private exportCsv(results: SearchResult[]): string {
    const rows = ['File,Type,Object,Line,Score,Snippet'];
    for (const r of results) {
      const snippet = (r.snippet?.split('\n')[0]?.trim() ?? '').replace(/"/g, '""');
      rows.push(`"${r.fileName}","${r.metadataType}","${r.objectName || ''}",${r.line},${Math.round(r.score)},"${snippet}"`);
    }
    return rows.join('\n');
  }

  private exportJson(results: SearchResult[]): string {
    const data = results.map(r => ({
      file: r.fileName,
      filePath: r.filePath,
      type: r.metadataType,
      object: r.objectName,
      line: r.line,
      score: Math.round(r.score),
      snippet: r.snippet?.split('\n')[0]?.trim() ?? '',
    }));
    return JSON.stringify(data, null, 2);
  }

  private exportMarkdown(results: SearchResult[]): string {
    const lines = [
      '| File | Type | Object | Line | Score |',
      '|------|------|--------|------|-------|',
    ];
    for (const r of results) {
      lines.push(`| ${r.fileName} | ${r.metadataType} | ${r.objectName || '—'} | ${r.line} | ${Math.round(r.score)} |`);
    }
    return lines.join('\n');
  }
}
