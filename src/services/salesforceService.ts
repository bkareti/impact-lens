import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { execFile } from 'child_process';

/**
 * Interface for metadata operations via Salesforce CLI.
 */
export interface IMetadataProvider {
  isCliAvailable(): Promise<boolean>;
  queryToolingApi(soql: string): Promise<unknown[]>;
  getPackageDirectories(): string[];
}

interface SoqlResult {
  status: number;
  result?: {
    records?: unknown[];
    totalSize?: number;
  };
}

// ── Org cache types ──────────────────────────────────────────────

/** A single cached metadata component with its code body. */
interface CachedComponent {
  id: string;
  name: string;
  type: string;
  body: string;            // full source / markup / value
  objectName: string;      // parent object, category, process type, etc.
  defType?: string;        // Aura DefType: CONTROLLER, HELPER, MARKUP…
}

/** Progress callback for UI updates during cache build. */
export type OrgCacheProgressFn = (stage: string, done: number, total: number) => void;

/**
 * Provides integration with the Salesforce CLI (sf / sfdx).
 */
export class SalesforceService implements IMetadataProvider {
  private outputChannel: vscode.OutputChannel;
  private packageDirectories: string[] = [];
  private cliAvailable: boolean | null = null;
  private sfdxProjectPath: string | null = null;

  /** In-memory metadata cache: populated once, searched locally. */
  private orgCache: CachedComponent[] = [];
  private orgCacheReady = false;
  private orgCacheLoading = false;
  /** Timestamp of the last cache build (epoch ms). */
  private orgCacheTimestamp = 0;

  constructor(outputChannel: vscode.OutputChannel) {
    this.outputChannel = outputChannel;
    this.detectSfdxProject();
  }

  /**
   * Detects the sfdx-project.json in the workspace and loads package directories.
   */
  private detectSfdxProject(): void {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders) {
      return;
    }

    for (const folder of folders) {
      const sfdxPath = path.join(folder.uri.fsPath, 'sfdx-project.json');
      if (fs.existsSync(sfdxPath)) {
        this.sfdxProjectPath = folder.uri.fsPath;
        try {
          const content = fs.readFileSync(sfdxPath, 'utf-8');
          const json = JSON.parse(content);
          if (Array.isArray(json.packageDirectories)) {
            this.packageDirectories = json.packageDirectories.map(
              (pd: { path: string }) => pd.path ?? 'force-app'
            );
          }
        } catch (err) {
          this.outputChannel.appendLine(
            `[SF] Failed to parse sfdx-project.json: ${err}`
          );
          this.packageDirectories = ['force-app'];
        }
        break;
      }
    }
  }

  /**
   * Check if the Salesforce CLI is available (sf or sfdx).
   */
  async isCliAvailable(): Promise<boolean> {
    if (this.cliAvailable !== null) {
      return this.cliAvailable;
    }

    try {
      await this.execCommand('sf', ['version']);
      this.cliAvailable = true;
    } catch {
      try {
        await this.execCommand('sfdx', ['version']);
        this.cliAvailable = true;
      } catch {
        this.cliAvailable = false;
      }
    }

    this.outputChannel.appendLine(
      `[SF] CLI available: ${this.cliAvailable}`
    );
    return this.cliAvailable;
  }

  /**
   * Query the Tooling API via the SF CLI.
   * Requires an authenticated org (default org set via sf org login).
   */
  async queryToolingApi(soql: string): Promise<unknown[]> {
    const config = vscode.workspace.getConfiguration('sfSearch');
    const useToolingApi = config.get<boolean>('enableToolingApi', false);
    if (!useToolingApi) {
      return [];
    }

    const available = await this.isCliAvailable();
    if (!available) {
      this.outputChannel.appendLine('[SF] CLI not available; skipping Tooling API query.');
      return [];
    }

    try {
      const result = await this.execCommand('sf', [
        'data', 'query',
        '--query', soql,
        '--use-tooling-api',
        '--json',
      ]);
      const parsed: SoqlResult = JSON.parse(result);

      if (parsed.status === 0 && parsed.result?.records) {
        return parsed.result.records;
      }
      return [];
    } catch (err) {
      this.outputChannel.appendLine(`[SF] Tooling API query failed: ${err}`);
      return [];
    }
  }

  /**
   * Returns the list of package directories from sfdx-project.json.
   */
  getPackageDirectories(): string[] {
    if (this.packageDirectories.length === 0) {
      this.detectSfdxProject();
    }
    return this.packageDirectories.length > 0
      ? this.packageDirectories
      : ['force-app'];
  }

  /**
   * Get the root path of the SFDX project.
   */
  getSfdxProjectPath(): string | null {
    return this.sfdxProjectPath;
  }

  /**
   * Execute a CLI command safely using execFile (no shell interpolation).
   * @param command The binary name (e.g., 'sf', 'sfdx')
   * @param args    Array of arguments passed directly — never interpolated into a shell string
   */
  private execCommand(command: string, args: string[]): Promise<string> {
    return new Promise((resolve, reject) => {
      const cwd = this.sfdxProjectPath ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      execFile(
        command,
        args,
        { cwd: cwd ?? undefined, maxBuffer: 10 * 1024 * 1024 },
        (error, stdout, stderr) => {
          if (error) {
            reject(new Error(`${error.message}\n${stderr}`));
            return;
          }
          resolve(stdout);
        }
      );
    });
  }

  /**
   * Sanitize a value for use in SOQL WHERE clauses.
   * Rejects anything outside [a-zA-Z0-9_.] to prevent injection.
   */
  private sanitizeSoqlParam(value: string): string {
    if (!/^[a-zA-Z0-9_.]+$/.test(value)) {
      throw new Error(`Invalid SOQL parameter: "${value}" contains disallowed characters.`);
    }
    return value;
  }

  /**
   * Get the configured org query concurrency.
   */
  private getOrgQueryConcurrency(): number {
    const config = vscode.workspace.getConfiguration('sfSearch');
    return config.get<number>('orgQueryConcurrency', 3);
  }

  /**
   * Query field usage from server-side metadata (e.g., page layouts, reports).
   */
  async queryFieldDependencies(objectName: string, fieldName: string): Promise<unknown[]> {
    const safeObj = this.sanitizeSoqlParam(objectName);
    const safeField = this.sanitizeSoqlParam(fieldName);
    const soql = `SELECT MetadataComponentId, MetadataComponentName, MetadataComponentType, RefMetadataComponentName, RefMetadataComponentType FROM MetadataComponentDependency WHERE RefMetadataComponentName = '${safeObj}.${safeField}'`;
    return this.queryToolingApi(soql);
  }

  /**
   * Query object references across the org metadata.
   */
  async queryObjectDependencies(objectName: string): Promise<unknown[]> {
    const safeObj = this.sanitizeSoqlParam(objectName);
    const soql = `SELECT MetadataComponentId, MetadataComponentName, MetadataComponentType, RefMetadataComponentName, RefMetadataComponentType FROM MetadataComponentDependency WHERE RefMetadataComponentName = '${safeObj}'`;
    return this.queryToolingApi(soql);
  }

  /**
   * Search connected org code/metadata.
   *
   * Strategy (mirrors SF Advanced Code Searcher Chrome extension):
   *   1. On first call, download ALL metadata names + code bodies from the org
   *      into an in-memory cache. Report progress per metadata type.
   *   2. Search the cache locally — instant results, no network overhead.
   *   3. Cache stays valid until explicitly refreshed (user clicks "Refresh Org Cache").
   *
   * This avoids spawning 10 CLI processes per keystroke.
   */
  async searchOrg(
    query: string,
    onProgress?: OrgCacheProgressFn,
  ): Promise<OrgSearchResult[]> {
    const available = await this.isCliAvailable();
    if (!available) {
      throw new Error('Salesforce CLI (sf/sfdx) is not installed or not found in PATH.');
    }

    // Build cache if not ready
    if (!this.orgCacheReady) {
      await this.buildOrgCache(onProgress);
    }

    // Search locally against the cache — instant
    return this.searchOrgCache(query);
  }

  /**
   * Force-refresh the org metadata cache.
   */
  async refreshOrgCache(onProgress?: OrgCacheProgressFn): Promise<void> {
    this.orgCache = [];
    this.orgCacheReady = false;
    await this.buildOrgCache(onProgress);
  }

  /** Whether the org cache is loaded and ready. */
  get isOrgCacheReady(): boolean {
    return this.orgCacheReady;
  }

  /** Number of cached components. */
  get orgCacheSize(): number {
    return this.orgCache.length;
  }

  // ── Cache builder ──────────────────────────────────────────────

  private async buildOrgCache(onProgress?: OrgCacheProgressFn): Promise<void> {
    if (this.orgCacheLoading) {
      // Wait for the existing build to complete
      while (this.orgCacheLoading) {
        await new Promise((r) => setTimeout(r, 200));
      }
      return;
    }

    this.orgCacheLoading = true;
    this.orgCache = [];
    const startTime = Date.now();
    this.outputChannel.appendLine('[SF] Building org metadata cache…');

    const metadataQueries: Array<{
      label: string;
      type: string;
      soql: string;
      bodyField: string;
      nameField: string;
      objectField?: string;
      defTypeField?: string;
    }> = [
      {
        label: 'Apex Classes',
        type: 'ApexClass',
        soql: 'SELECT Id, Name, Body FROM ApexClass ORDER BY Name LIMIT 2000',
        bodyField: 'Body',
        nameField: 'Name',
      },
      {
        label: 'Apex Triggers',
        type: 'ApexTrigger',
        soql: 'SELECT Id, Name, Body FROM ApexTrigger ORDER BY Name LIMIT 2000',
        bodyField: 'Body',
        nameField: 'Name',
      },
      {
        label: 'Visualforce Pages',
        type: 'VisualforcePage',
        soql: 'SELECT Id, Name, Markup FROM ApexPage ORDER BY Name LIMIT 2000',
        bodyField: 'Markup',
        nameField: 'Name',
      },
      {
        label: 'Visualforce Components',
        type: 'VisualforceComponent',
        soql: 'SELECT Id, Name, Markup FROM ApexComponent ORDER BY Name LIMIT 2000',
        bodyField: 'Markup',
        nameField: 'Name',
      },
      {
        label: 'Aura Components',
        type: 'AuraDefinition',
        soql: 'SELECT Id, AuraDefinitionBundleId, AuraDefinitionBundle.DeveloperName, DefType, Source FROM AuraDefinition ORDER BY AuraDefinitionBundle.DeveloperName LIMIT 2000',
        bodyField: 'Source',
        nameField: 'AuraDefinitionBundle.DeveloperName',
        defTypeField: 'DefType',
      },
      {
        label: 'Custom Labels',
        type: 'CustomLabel',
        soql: "SELECT Id, Name, Value, Category FROM ExternalString ORDER BY Name LIMIT 2000",
        bodyField: 'Value',
        nameField: 'Name',
        objectField: 'Category',
      },
      {
        label: 'Validation Rules',
        type: 'ValidationRule',
        soql: 'SELECT Id, ValidationName, EntityDefinition.QualifiedApiName FROM ValidationRule ORDER BY ValidationName LIMIT 2000',
        bodyField: '',
        nameField: 'ValidationName',
      },
      {
        label: 'Flows',
        type: 'Flow',
        soql: "SELECT Id, DeveloperName, ProcessType FROM Flow WHERE Status = 'Active' ORDER BY DeveloperName LIMIT 2000",
        bodyField: '',
        nameField: 'DeveloperName',
        objectField: 'ProcessType',
      },
    ];

    const total = metadataQueries.length;
    const concurrency = this.getOrgQueryConcurrency();

    // Execute queries in parallel batches for performance
    for (let batchStart = 0; batchStart < total; batchStart += concurrency) {
      const batch = metadataQueries.slice(batchStart, batchStart + concurrency);
      const batchPromises = batch.map(async (q, batchIdx) => {
        const globalIdx = batchStart + batchIdx;
        onProgress?.(q.label, globalIdx, total);

        try {
          const records = await this.runToolingQuery(q.soql);
          for (const rec of records) {
            const record = rec as Record<string, unknown>;
            let name = '';
            if (q.nameField.includes('.')) {
              const parts = q.nameField.split('.');
              const parent = record[parts[0]] as Record<string, unknown> | undefined;
              name = parent ? String(parent[parts[1]] ?? '') : '';
            } else {
              name = String(record[q.nameField] ?? record['Name'] ?? '');
            }

            const body = q.bodyField ? String(record[q.bodyField] ?? '') : name;
            const defType = q.defTypeField ? String(record[q.defTypeField] ?? '') : undefined;

            let objectName = '';
            if (q.objectField) {
              objectName = String(record[q.objectField] ?? '');
            } else if (record['EntityDefinition']) {
              objectName = String((record['EntityDefinition'] as Record<string, unknown>)['QualifiedApiName'] ?? '');
            }

            this.orgCache.push({
              id: String(record['Id'] ?? ''),
              name: defType ? `${name} (${defType})` : name,
              type: q.type,
              body,
              objectName,
              defType,
            });
          }

          this.outputChannel.appendLine(`[SF]   ${q.label}: ${records.length} records cached.`);
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          this.outputChannel.appendLine(`[SF]   ${q.label}: FAILED — ${msg}`);
          // Non-fatal: continue with next type
        }
      });

      await Promise.all(batchPromises);
    }

    onProgress?.('Done', total, total);
    this.orgCacheReady = true;
    this.orgCacheLoading = false;
    this.orgCacheTimestamp = Date.now();

    const elapsed = Date.now() - startTime;
    this.outputChannel.appendLine(
      `[SF] Org cache built: ${this.orgCache.length} components in ${elapsed}ms.`
    );
  }

  // ── Local in-memory search ─────────────────────────────────────

  private searchOrgCache(query: string): OrgSearchResult[] {
    const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (terms.length === 0) {
      return [];
    }

    const results: OrgSearchResult[] = [];

    for (const comp of this.orgCache) {
      // Score: name match > body match
      const nameLower = comp.name.toLowerCase();
      const bodyLower = comp.body.toLowerCase();

      let score = 0;
      let allTermsMatch = true;

      for (const term of terms) {
        const nameHit = nameLower.includes(term);
        const bodyHit = bodyLower.includes(term);

        if (!nameHit && !bodyHit) {
          allTermsMatch = false;
          break;
        }

        if (nameLower === term) {
          score += 100;            // exact name match
        } else if (nameHit) {
          score += 50;             // partial name match
        } else if (bodyHit) {
          score += 10;             // body-only match
        }
      }

      if (!allTermsMatch) {
        continue;
      }

      // Extract snippet from body around the first term match
      let snippet = '';
      for (const term of terms) {
        const idx = bodyLower.indexOf(term);
        if (idx !== -1) {
          snippet = this.extractSnippet(comp.body, term);
          break;
        }
      }

      results.push({
        name: comp.name,
        type: comp.type,
        snippet: snippet || `${comp.type} — ${comp.name}`,
        id: comp.id,
        objectName: comp.objectName,
        score,
      });
    }

    // Sort by score descending, limit to 200
    results.sort((a, b) => b.score - a.score);
    return results.slice(0, 200);
  }

  /**
   * Run a single Tooling API SOQL query and return the records.
   */
  private async runToolingQuery(soql: string): Promise<unknown[]> {
    const raw = await this.execCommand('sf', [
      'data', 'query',
      '--query', soql,
      '--use-tooling-api',
      '--json',
    ]);
    const parsed: SoqlResult = JSON.parse(raw);

    if (parsed.status !== 0 || !parsed.result?.records) {
      return [];
    }

    return parsed.result.records;
  }

  /**
   * Extract a relevant snippet around the search term from a code body.
   */
  private extractSnippet(body: string, searchTerm: string): string {
    const index = body.toLowerCase().indexOf(searchTerm.toLowerCase());
    if (index === -1) {
      // Return first 200 chars if term not found (shouldn't happen with LIKE query)
      return body.substring(0, 200).replace(/\s+/g, ' ').trim();
    }

    const start = Math.max(0, index - 60);
    const end = Math.min(body.length, index + searchTerm.length + 100);
    let snippet = body.substring(start, end).replace(/\s+/g, ' ').trim();

    if (start > 0) {
      snippet = '…' + snippet;
    }
    if (end < body.length) {
      snippet = snippet + '…';
    }

    return snippet;
  }
}

/**
 * A search result from the connected org's Tooling API.
 */
export interface OrgSearchResult {
  name: string;
  type: string;
  snippet: string;
  id: string;
  objectName: string;
  score: number;
}

