/**
 * A node in the dependency graph.
 */
export interface DependencyNode {
  /** Metadata API name (e.g., Account.Status__c, OpportunityService) */
  name: string;
  /** Metadata type */
  type: string;
  /** File path */
  filePath: string;
  /** Children dependencies */
  children: DependencyNode[];
  /** Reference count */
  referenceCount: number;
  /** Line number where dependency occurs */
  line?: number;
  /** Snippet of code where dependency is used */
  snippet?: string;
  /** Risk level for this node */
  riskLevel?: string;
  /** Depth in the dependency chain */
  depth?: number;
}

/**
 * Dependency edge in the graph.
 */
export interface DependencyEdge {
  /** Source node name */
  source: string;
  /** Source metadata type */
  sourceType: string;
  /** Target node name */
  target: string;
  /** Target metadata type */
  targetType: string;
  /** Line in source where reference occurs */
  line: number;
  /** File path of source */
  filePath: string;
}

/**
 * Complete dependency graph.
 */
export interface DependencyGraph {
  /** All nodes */
  nodes: Map<string, DependencyNode>;
  /** All edges */
  edges: DependencyEdge[];
}
