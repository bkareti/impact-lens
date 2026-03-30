/**
 * Supported Salesforce metadata types for indexing and search.
 */
export enum MetadataType {
  ApexClass = 'Apex Class',
  ApexTrigger = 'Apex Trigger',
  LWC = 'LWC',
  Aura = 'Aura',
  Flow = 'Flow',
  ValidationRule = 'Validation Rule',
  WorkflowRule = 'Workflow Rule',
  CustomObject = 'Custom Object',
  CustomField = 'Custom Field',
  CustomMetadata = 'Custom Metadata',
  PermissionSet = 'Permission Set',
  Profile = 'Profile',
  Layout = 'Layout',
  Report = 'Report',
  EmailTemplate = 'Email Template',
  NamedCredential = 'Named Credential',
  PlatformEvent = 'Platform Event',
  VisualforcePage = 'Visualforce Page',
  VisualforceComponent = 'Visualforce Component',
  CustomLabel = 'Custom Label',
  StaticResource = 'Static Resource',
  FlexiPage = 'FlexiPage',
  ApprovalProcess = 'Approval Process',
  SharingRule = 'Sharing Rule',
  RecordType = 'Record Type',
  QuickAction = 'Quick Action',
  GlobalValueSet = 'Global Value Set',
  CustomSetting = 'Custom Setting',
  Unknown = 'Unknown',
}

/**
 * Risk level for impact analysis scoring.
 */
export enum RiskLevel {
  Low = 'Low',
  Medium = 'Medium',
  High = 'High',
  Critical = 'Critical',
}

/**
 * Export formats for search results and impact reports.
 */
export enum ExportFormat {
  CSV = 'csv',
  JSON = 'json',
  Markdown = 'markdown',
}

/**
 * A persisted search history entry.
 */
export interface SearchHistoryEntry {
  query: string;
  timestamp: number;
  resultCount: number;
  pinned: boolean;
  filters?: Record<string, boolean | undefined>;
}

/**
 * A single reference found during indexing.
 */
export interface ReferenceEntry {
  /** The API name or keyword being referenced */
  keyword: string;
  /** Absolute file path */
  filePath: string;
  /** File name (basename) */
  fileName: string;
  /** Line number (1-based) */
  line: number;
  /** Column number (0-based) */
  column: number;
  /** The metadata type of the containing file */
  metadataType: MetadataType;
  /** Object name (e.g., Account for Account.Status__c) */
  objectName: string;
  /** Code snippet around the reference */
  snippet: string;
}

/**
 * A search result returned to the UI.
 */
export interface SearchResult {
  /** The API name or keyword matched */
  keyword: string;
  /** Absolute file path */
  filePath: string;
  /** File name */
  fileName: string;
  /** Metadata type of the file */
  metadataType: MetadataType;
  /** Object name if applicable */
  objectName: string;
  /** Line number (1-based) */
  line: number;
  /** Column number (0-based) */
  column: number;
  /** Code snippet with context */
  snippet: string;
  /** Relevance score from search engine */
  score: number;
}

/**
 * Impact report for a metadata element.
 */
export interface ImpactReport {
  /** The metadata name being analyzed */
  metadataName: string;
  /** Timestamp when the report was generated */
  generatedAt: number;
  /** Total count of references */
  totalReferences: number;
  /** References grouped by metadata type */
  byType: Map<MetadataType, ReferenceEntry[]>;
  /** Summary counts per type */
  summaryCounts: Record<string, number>;
  /** Computed risk level */
  riskLevel: RiskLevel;
  /** Numeric risk score (0-100) */
  riskScore: number;
  /** Total unique files affected */
  affectedFiles: number;
  /** Whether circular dependencies were detected during traversal */
  hasCircularDeps: boolean;
  /** Max traversal depth reached */
  maxDepthReached: number;
}

/**
 * A document stored in the search index.
 */
export interface IndexDocument {
  /** Unique ID for the document (file path) */
  id: string;
  /** File name */
  name: string;
  /** Metadata type */
  type: MetadataType;
  /** Object name */
  objectName: string;
  /** Full text content of the file */
  content: string;
  /** Extracted references (comma-separated API names) */
  references: string;
  /** Extracted method/function names */
  methods: string;
  /** File path */
  filePath: string;
}

/**
 * File metadata for staleness tracking.
 */
export interface FileMetadata {
  filePath: string;
  mtime: number;
  size: number;
  metadataType: MetadataType;
}

/**
 * Parsed file result from the file parser.
 */
export interface ParsedFile {
  filePath: string;
  fileName: string;
  metadataType: MetadataType;
  objectName: string;
  content: string;
  references: string[];
  methods: string[];
  lineReferences: LineReference[];
}

/**
 * A keyword reference at a specific line.
 */
export interface LineReference {
  keyword: string;
  line: number;
  column: number;
  snippet: string;
}

/**
 * Serializable index data for persistence.
 */
export interface SerializedIndex {
  version: number;
  timestamp: number;
  documents: IndexDocument[];
  referenceGraph: Record<string, ReferenceEntry[]>;
  fileMtimes: Record<string, number>;
}

/**
 * Message types for worker thread communication.
 */
export enum WorkerMessageType {
  ParseFiles = 'parseFiles',
  ParseResult = 'parseResult',
  ParseError = 'parseError',
  ParseComplete = 'parseComplete',
  Progress = 'progress',
}

/**
 * Worker thread message.
 */
export interface WorkerMessage {
  type: WorkerMessageType;
  payload?: unknown;
}

/**
 * Worker parse request.
 */
export interface WorkerParseRequest {
  files: Array<{ path: string; metadataType: MetadataType }>;
}

/**
 * Worker parse result.
 */
export interface WorkerParseResult {
  parsed: ParsedFile[];
  errors: Array<{ file: string; error: string }>;
}
