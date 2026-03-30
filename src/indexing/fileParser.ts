import * as path from 'path';
import { XMLParser } from 'fast-xml-parser';
import {
  MetadataType,
  ParsedFile,
  LineReference,
} from '../models/searchResult';

/**
 * Determines the MetadataType from a file path.
 */
export function classifyFile(filePath: string): MetadataType {
  const ext = path.extname(filePath).toLowerCase();
  const normalized = filePath.replace(/\\/g, '/');

  if (ext === '.cls') { return MetadataType.ApexClass; }
  if (ext === '.trigger') { return MetadataType.ApexTrigger; }
  if (ext === '.page') { return MetadataType.VisualforcePage; }
  if (ext === '.component' && normalized.includes('/components/')) {
    return MetadataType.VisualforceComponent;
  }

  if (normalized.includes('/lwc/')) {
    if (ext === '.js' || ext === '.html' || ext === '.css') { return MetadataType.LWC; }
  }
  if (normalized.includes('/aura/')) {
    if (ext === '.cmp' || ext === '.app' || ext === '.evt' || ext === '.js') {
      return MetadataType.Aura;
    }
  }

  if (filePath.endsWith('.flow-meta.xml')) { return MetadataType.Flow; }
  if (filePath.endsWith('.object-meta.xml')) { return MetadataType.CustomObject; }
  if (filePath.endsWith('.field-meta.xml')) { return MetadataType.CustomField; }
  if (filePath.endsWith('.permissionset-meta.xml')) { return MetadataType.PermissionSet; }
  if (filePath.endsWith('.profile-meta.xml')) { return MetadataType.Profile; }
  if (filePath.endsWith('.layout-meta.xml')) { return MetadataType.Layout; }
  if (filePath.endsWith('.labels-meta.xml')) { return MetadataType.CustomLabel; }
  if (filePath.endsWith('.md-meta.xml')) { return MetadataType.CustomMetadata; }
  if (filePath.endsWith('.flexipage-meta.xml')) { return MetadataType.FlexiPage; }
  if (filePath.endsWith('.email-meta.xml')) { return MetadataType.EmailTemplate; }
  if (filePath.endsWith('.namedCredential-meta.xml')) { return MetadataType.NamedCredential; }
  if (filePath.endsWith('.approvalProcess-meta.xml')) { return MetadataType.ApprovalProcess; }
  if (filePath.endsWith('.sharingRules-meta.xml')) { return MetadataType.SharingRule; }
  if (filePath.endsWith('.recordType-meta.xml')) { return MetadataType.RecordType; }
  if (filePath.endsWith('.quickAction-meta.xml')) { return MetadataType.QuickAction; }
  if (filePath.endsWith('.globalValueSet-meta.xml')) { return MetadataType.GlobalValueSet; }
  if (filePath.endsWith('.customSetting-meta.xml')) { return MetadataType.CustomSetting; }

  if (normalized.includes('/objects/') && ext === '.xml') {
    if (normalized.includes('/validationRules/')) { return MetadataType.ValidationRule; }
    if (normalized.includes('/fields/')) { return MetadataType.CustomField; }
    if (normalized.includes('/recordTypes/')) { return MetadataType.RecordType; }
    return MetadataType.CustomObject;
  }

  return MetadataType.Unknown;
}

/**
 * Extract the object name from a file path.
 * e.g., force-app/main/default/objects/Account/fields/Status__c.field-meta.xml → Account
 */
export function extractObjectName(filePath: string): string {
  const normalized = filePath.replace(/\\/g, '/');
  const objectsMatch = normalized.match(/\/objects\/([^/]+)\//);
  if (objectsMatch) {
    return objectsMatch[1];
  }

  // For triggers, try to extract from filename
  const triggerMatch = normalized.match(/\/triggers\/([^/]+)\./);
  if (triggerMatch) {
    return triggerMatch[1];
  }

  return '';
}

/**
 * Extract a code snippet around a given line.
 */
function getSnippet(lines: string[], lineIndex: number, contextLines: number = 1): string {
  const start = Math.max(0, lineIndex - contextLines);
  const end = Math.min(lines.length - 1, lineIndex + contextLines);
  return lines.slice(start, end + 1).join('\n').trim();
}

// ─────────────────────────────────────────────────────────────────
// REGEX PATTERNS for Salesforce reference extraction
// ─────────────────────────────────────────────────────────────────

/** Matches Salesforce custom field/object API names: Name__c, Account.Status__c, ns__Field__c */
const SF_API_NAME_PATTERN = /\b([A-Za-z]\w*(?:__[a-zA-Z]+)?\.)?([A-Za-z]\w*__[crex])\b/g;

/** Matches standard Salesforce objects in SOQL: FROM Account, FROM Contact, etc. */
const SOQL_FROM_PATTERN = /\bFROM\s+([A-Za-z]\w*)/gi;

/** Matches SOQL field references: SELECT Name, Status__c, Account.Name */
const SOQL_SELECT_FIELDS = /\bSELECT\s+([\s\S]*?)\bFROM\b/gi;

/** Matches Apex class references: ClassName.method() */
const APEX_CLASS_REF = /\b([A-Z][A-Za-z0-9_]+)\s*\.\s*[a-zA-Z]/g;

/** Matches Apex class instantiation: new ClassName() */
const APEX_NEW_INSTANCE = /\bnew\s+([A-Z][A-Za-z0-9_]+)\s*\(/g;

/** Matches Apex class declaration */
const APEX_CLASS_DECL = /\b(?:class|interface|enum)\s+([A-Za-z]\w+)/g;

/** Matches Apex method declarations */
const APEX_METHOD_DECL = /\b(?:public|private|protected|global|static|override|virtual|abstract|testMethod)\s+(?:\w+\s+)*(\w+)\s*\(/g;

/** Matches Apex trigger declaration: trigger Name on Object */
const APEX_TRIGGER_DECL = /\btrigger\s+(\w+)\s+on\s+(\w+)/g;

/** LWC import from @salesforce */
const LWC_SF_IMPORT = /import\s+\w+\s+from\s+['"]@salesforce\/(?:apex|schema|label|messageChannel|resourceUrl|user)\/([^'"]+)['"]/g;

/** LWC import from other components */
const LWC_COMPONENT_IMPORT = /import\s+\w+\s+from\s+['"]c\/([^'"]+)['"]/g;

/** Aura component references */
const AURA_COMPONENT_REF = /<(?:c|aura|lightning|force|ui):([A-Za-z]\w*)/g;

/** Aura controller action reference */
const AURA_ACTION = /getReference\s*\(\s*['"]c\.(\w+)['"]\s*\)/g;

// ─── Visualforce-specific patterns ──────────────────────────────────────────

/** VF page controller attribute: <apex:page controller="MyController"> */
const VF_CONTROLLER = /<apex:page[^>]*\bcontroller=["']([^"']+)["']/gi;

/** VF page extensions attribute */
const VF_EXTENSIONS = /<apex:page[^>]*\bextensions=["']([^"']+)["']/gi;

/** VF inputField value bindings: <apex:inputField value="{!Account.Status__c}"/> */
const VF_INPUT_FIELD = /<apex:(?:inputField|outputField|column)[^>]*\bvalue=["']\{!([^}]+)\}["']/gi;

/** VF action method bindings: action="{!save}" */
const VF_ACTION = /\baction=["']\{!([^}]+)\}["']/gi;

/** VF component references: <apex:someComponent> or <c:myComponent> */
const VF_COMPONENT_REF = /<(?:apex|c):([A-Za-z]\w*)/g;

// ─── Flow-specific XML tags (deeper extraction) ────────────────────────────

/** Flow elements that reference objects/classes */
const FLOW_REF_TAGS = /<(?:actionName|apexClass|flowName|object|objectType|targetReference|assignToReference|processMetadataValues)>([^<]+)<\//g;

/**
 * Parse an Apex file (.cls or .trigger) for references.
 */
function parseApex(content: string, lines: string[]): { refs: string[]; methods: string[]; lineRefs: LineReference[] } {
  const refs: Set<string> = new Set();
  const methods: string[] = [];
  const lineRefs: LineReference[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match: RegExpExecArray | null;

    // SF API names (custom fields/objects)
    const apiPattern = new RegExp(SF_API_NAME_PATTERN.source, 'g');
    while ((match = apiPattern.exec(line)) !== null) {
      const fullName = match[0];
      refs.add(fullName);
      lineRefs.push({
        keyword: fullName,
        line: i + 1,
        column: match.index,
        snippet: getSnippet(lines, i),
      });
    }

    // SOQL FROM clauses
    const fromPattern = new RegExp(SOQL_FROM_PATTERN.source, 'gi');
    while ((match = fromPattern.exec(line)) !== null) {
      refs.add(match[1]);
      lineRefs.push({
        keyword: match[1],
        line: i + 1,
        column: match.index,
        snippet: getSnippet(lines, i),
      });
    }

    // Apex class references
    const classRefPattern = new RegExp(APEX_CLASS_REF.source, 'g');
    while ((match = classRefPattern.exec(line)) !== null) {
      const className = match[1];
      if (!isApexKeyword(className)) {
        refs.add(className);
        lineRefs.push({
          keyword: className,
          line: i + 1,
          column: match.index,
          snippet: getSnippet(lines, i),
        });
      }
    }

    // new ClassName()
    const newPattern = new RegExp(APEX_NEW_INSTANCE.source, 'g');
    while ((match = newPattern.exec(line)) !== null) {
      const className = match[1];
      if (!isApexKeyword(className)) {
        refs.add(className);
        lineRefs.push({
          keyword: className,
          line: i + 1,
          column: match.index,
          snippet: getSnippet(lines, i),
        });
      }
    }

    // Method declarations
    const methodPattern = new RegExp(APEX_METHOD_DECL.source, 'g');
    while ((match = methodPattern.exec(line)) !== null) {
      methods.push(match[1]);
    }

    // Trigger declarations
    const triggerPattern = new RegExp(APEX_TRIGGER_DECL.source, 'g');
    while ((match = triggerPattern.exec(line)) !== null) {
      refs.add(match[2]); // Object name
      lineRefs.push({
        keyword: match[2],
        line: i + 1,
        column: match.index,
        snippet: getSnippet(lines, i),
      });
    }
  }

  // Also extract SOQL SELECT fields across multi-line queries
  const selectPattern = new RegExp(SOQL_SELECT_FIELDS.source, 'gi');
  let match: RegExpExecArray | null;
  while ((match = selectPattern.exec(content)) !== null) {
    const fieldsList = match[1];
    const fields = fieldsList.split(',').map(f => f.trim()).filter(Boolean);
    for (const field of fields) {
      const clean = field.replace(/\s+/g, '');
      if (clean && !isApexKeyword(clean)) {
        refs.add(clean);
      }
    }
  }

  // Extract class declarations as methods too
  const classDeclPattern = new RegExp(APEX_CLASS_DECL.source, 'g');
  while ((match = classDeclPattern.exec(content)) !== null) {
    methods.push(match[1]);
  }

  return { refs: Array.from(refs), methods, lineRefs };
}

/**
 * Parse a JavaScript/HTML file for LWC references.
 */
function parseLwc(content: string, lines: string[]): { refs: string[]; methods: string[]; lineRefs: LineReference[] } {
  const refs: Set<string> = new Set();
  const methods: string[] = [];
  const lineRefs: LineReference[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match: RegExpExecArray | null;

    // @salesforce imports
    const sfImport = new RegExp(LWC_SF_IMPORT.source, 'g');
    while ((match = sfImport.exec(line)) !== null) {
      refs.add(match[1]);
      lineRefs.push({
        keyword: match[1],
        line: i + 1,
        column: match.index,
        snippet: getSnippet(lines, i),
      });
    }

    // c/ component imports
    const cImport = new RegExp(LWC_COMPONENT_IMPORT.source, 'g');
    while ((match = cImport.exec(line)) !== null) {
      refs.add(match[1]);
      lineRefs.push({
        keyword: match[1],
        line: i + 1,
        column: match.index,
        snippet: getSnippet(lines, i),
      });
    }

    // SF API names in JS
    const apiPattern = new RegExp(SF_API_NAME_PATTERN.source, 'g');
    while ((match = apiPattern.exec(line)) !== null) {
      refs.add(match[0]);
      lineRefs.push({
        keyword: match[0],
        line: i + 1,
        column: match.index,
        snippet: getSnippet(lines, i),
      });
    }

    // Function/method declarations
    const funcMatch = line.match(/(?:async\s+)?(\w+)\s*\(.*\)\s*\{/);
    if (funcMatch && funcMatch[1] && !isJsKeyword(funcMatch[1])) {
      methods.push(funcMatch[1]);
    }
  }

  // Parse HTML template for component references: <c-my-component>
  const htmlComponentPattern = /<c-([a-z][a-z0-9-]*)/g;
  let match: RegExpExecArray | null;
  while ((match = htmlComponentPattern.exec(content)) !== null) {
    // Convert kebab-case to camelCase
    const camelName = match[1].replace(/-([a-z])/g, (_, l) => l.toUpperCase());
    refs.add(camelName);
  }

  return { refs: Array.from(refs), methods, lineRefs };
}

/**
 * Parse an Aura component file for references.
 */
function parseAura(content: string, lines: string[]): { refs: string[]; methods: string[]; lineRefs: LineReference[] } {
  const refs: Set<string> = new Set();
  const methods: string[] = [];
  const lineRefs: LineReference[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match: RegExpExecArray | null;

    // Aura component references
    const compRef = new RegExp(AURA_COMPONENT_REF.source, 'g');
    while ((match = compRef.exec(line)) !== null) {
      refs.add(match[1]);
      lineRefs.push({
        keyword: match[1],
        line: i + 1,
        column: match.index,
        snippet: getSnippet(lines, i),
      });
    }

    // Controller action references
    const actionRef = new RegExp(AURA_ACTION.source, 'g');
    while ((match = actionRef.exec(line)) !== null) {
      refs.add(match[1]);
      lineRefs.push({
        keyword: match[1],
        line: i + 1,
        column: match.index,
        snippet: getSnippet(lines, i),
      });
    }

    // SF API names
    const apiPattern = new RegExp(SF_API_NAME_PATTERN.source, 'g');
    while ((match = apiPattern.exec(line)) !== null) {
      refs.add(match[0]);
      lineRefs.push({
        keyword: match[0],
        line: i + 1,
        column: match.index,
        snippet: getSnippet(lines, i),
      });
    }
  }

  return { refs: Array.from(refs), methods, lineRefs };
}

/**
 * Parse a Visualforce page or component for references.
 */
function parseVisualforce(content: string, lines: string[]): { refs: string[]; methods: string[]; lineRefs: LineReference[] } {
  const refs: Set<string> = new Set();
  const methods: string[] = [];
  const lineRefs: LineReference[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match: RegExpExecArray | null;

    // Controller
    const ctrlPattern = new RegExp(VF_CONTROLLER.source, 'gi');
    while ((match = ctrlPattern.exec(line)) !== null) {
      refs.add(match[1]);
      lineRefs.push({ keyword: match[1], line: i + 1, column: match.index, snippet: getSnippet(lines, i) });
    }

    // Extensions
    const extPattern = new RegExp(VF_EXTENSIONS.source, 'gi');
    while ((match = extPattern.exec(line)) !== null) {
      const extensions = match[1].split(',').map(e => e.trim()).filter(Boolean);
      for (const ext of extensions) {
        refs.add(ext);
        lineRefs.push({ keyword: ext, line: i + 1, column: match.index, snippet: getSnippet(lines, i) });
      }
    }

    // Input/output field value bindings  e.g. {!Account.Status__c}
    const fieldPattern = new RegExp(VF_INPUT_FIELD.source, 'gi');
    while ((match = fieldPattern.exec(line)) !== null) {
      const binding = match[1].trim();
      refs.add(binding);
      // Also add individual parts (object + field)
      const parts = binding.split('.');
      for (const part of parts) {
        if (part && !isApexKeyword(part)) {
          refs.add(part);
        }
      }
      lineRefs.push({ keyword: binding, line: i + 1, column: match.index, snippet: getSnippet(lines, i) });
    }

    // Action bindings  e.g. action="{!save}"
    const actionPattern = new RegExp(VF_ACTION.source, 'gi');
    while ((match = actionPattern.exec(line)) !== null) {
      const methodName = match[1].trim();
      refs.add(methodName);
      methods.push(methodName);
      lineRefs.push({ keyword: methodName, line: i + 1, column: match.index, snippet: getSnippet(lines, i) });
    }

    // Component references <apex:xxx> <c:xxx>
    const compRefPattern = new RegExp(VF_COMPONENT_REF.source, 'g');
    while ((match = compRefPattern.exec(line)) !== null) {
      refs.add(match[1]);
      lineRefs.push({ keyword: match[1], line: i + 1, column: match.index, snippet: getSnippet(lines, i) });
    }

    // SF API names
    const apiPattern = new RegExp(SF_API_NAME_PATTERN.source, 'g');
    while ((match = apiPattern.exec(line)) !== null) {
      refs.add(match[0]);
      lineRefs.push({ keyword: match[0], line: i + 1, column: match.index, snippet: getSnippet(lines, i) });
    }
  }

  return { refs: Array.from(refs), methods, lineRefs };
}

/**
 * Parse an XML metadata file for references.
 */
function parseXml(content: string, lines: string[], metadataType: MetadataType): { refs: string[]; methods: string[]; lineRefs: LineReference[] } {
  const refs: Set<string> = new Set();
  const lineRefs: LineReference[] = [];

  const xmlParser = new XMLParser({
    ignoreAttributes: false,
    attributeNamePrefix: '@_',
  });

  // Line-based extraction for line numbers
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    let match: RegExpExecArray | null;

    // SF API names in XML
    const apiPattern = new RegExp(SF_API_NAME_PATTERN.source, 'g');
    while ((match = apiPattern.exec(line)) !== null) {
      refs.add(match[0]);
      lineRefs.push({
        keyword: match[0],
        line: i + 1,
        column: match.index,
        snippet: getSnippet(lines, i),
      });
    }

    // Standard Salesforce object names inside XML tags
    const xmlFieldRef = /<(?:field|referenceTo|objectType|object|sObjectType|entityType)>([^<]+)<\//g;
    while ((match = xmlFieldRef.exec(line)) !== null) {
      refs.add(match[1].trim());
      lineRefs.push({
        keyword: match[1].trim(),
        line: i + 1,
        column: match.index,
        snippet: getSnippet(lines, i),
      });
    }

    // Flow action/formula/object references (deep extraction)
    const flowRefPattern = new RegExp(FLOW_REF_TAGS.source, 'g');
    while ((match = flowRefPattern.exec(line)) !== null) {
      const val = match[1].trim();
      if (val && !isXmlBoilerplate(val)) {
        refs.add(val);
        lineRefs.push({
          keyword: val,
          line: i + 1,
          column: match.index,
          snippet: getSnippet(lines, i),
        });
      }
    }
  }

  // Deep parse XML structure for additional references
  try {
    const parsed = xmlParser.parse(content);
    extractXmlReferences(parsed, refs);
  } catch {
    // XML parse errors are non-fatal; line-based extraction already captured references
  }

  return { refs: Array.from(refs), methods: [], lineRefs };
}

/**
 * Recursively extract references from parsed XML objects.
 * Only adds values that look like genuine Salesforce API names.
 */
function extractXmlReferences(obj: unknown, refs: Set<string>): void {
  if (typeof obj === 'string') {
    const trimmed = obj.trim();
    if (trimmed.length <= 2 || isXmlBoilerplate(trimmed)) { return; }

    // Only accept strings that look like real SF API names:
    // 1. Custom API names with __c, __r, __e, __x suffix
    // 2. Values from known reference keys (handled separately below)
    // 3. Dotted names like Account.Status__c
    const isCustomApiName = /^[A-Za-z]\w*__[crex]$/i.test(trimmed);
    const isDottedRef = /^[A-Za-z]\w*\.[A-Za-z]\w*$/.test(trimmed);
    if (isCustomApiName || isDottedRef) {
      refs.add(trimmed);
    }
    return;
  }
  if (Array.isArray(obj)) {
    for (const item of obj) {
      extractXmlReferences(item, refs);
    }
    return;
  }
  if (typeof obj === 'object' && obj !== null) {
    for (const [key, value] of Object.entries(obj)) {
      if (isReferenceKey(key)) {
        if (typeof value === 'string') {
          const v = value.trim();
          // Only add values that look like SF identifiers (e.g. Account, Status__c, MyApexClass)
          if (v.length > 1 && /^[A-Za-z][A-Za-z0-9_.]*$/.test(v) && !isXmlBoilerplate(v)) {
            refs.add(v);
          }
        }
      }
      extractXmlReferences(value, refs);
    }
  }
}

const REFERENCE_KEYS = new Set([
  'field', 'referenceTo', 'objectType', 'object', 'sObjectType',
  'entityType', 'actionName', 'apexClass', 'flowName', 'customObject',
  'name', 'fullName', 'lookupFilter', 'relatedList', 'customPermission',
  'targetReference', 'assignToReference', 'processMetadataValues',
  'recordType', 'sharingModel', 'masterLabel', 'quickActionName',
]);

function isReferenceKey(key: string): boolean {
  return REFERENCE_KEYS.has(key);
}

// ─────────────────────────────────────────────────────────────────
// Keyword filters
// ─────────────────────────────────────────────────────────────────

const APEX_KEYWORDS = new Set([
  'String', 'Integer', 'Boolean', 'Decimal', 'Double', 'Long', 'Blob',
  'Date', 'Datetime', 'Time', 'Id', 'Object', 'List', 'Set', 'Map',
  'System', 'Database', 'Test', 'Assert', 'Schema', 'Type', 'Math',
  'Limits', 'UserInfo', 'Trigger', 'ApexPages', 'Messaging',
  'void', 'null', 'true', 'false', 'this', 'super',
  'if', 'else', 'for', 'while', 'do', 'switch', 'when',
  'try', 'catch', 'finally', 'throw', 'return', 'break', 'continue',
  'class', 'interface', 'enum', 'extends', 'implements',
  'public', 'private', 'protected', 'global', 'static',
  'final', 'abstract', 'virtual', 'override', 'transient',
  'insert', 'update', 'delete', 'upsert', 'merge', 'undelete',
  'SObject', 'DMLException', 'QueryException', 'Exception',
  'Comparable', 'Iterable', 'Iterator', 'Schedulable', 'Queueable', 'Batchable',
]);

function isApexKeyword(word: string): boolean {
  return APEX_KEYWORDS.has(word);
}

const JS_KEYWORDS = new Set([
  'if', 'else', 'for', 'while', 'do', 'switch', 'case', 'break',
  'continue', 'return', 'function', 'class', 'const', 'let', 'var',
  'new', 'this', 'super', 'import', 'export', 'default', 'from',
  'true', 'false', 'null', 'undefined', 'typeof', 'instanceof',
  'async', 'await', 'try', 'catch', 'finally', 'throw',
  'constructor', 'get', 'set', 'static', 'extends',
  'console', 'window', 'document', 'JSON', 'Array', 'Object',
  'String', 'Number', 'Boolean', 'Map', 'Set', 'Promise',
  'connectedCallback', 'disconnectedCallback', 'renderedCallback',
  'render', 'errorCallback',
]);

function isJsKeyword(word: string): boolean {
  return JS_KEYWORDS.has(word);
}

/** Common XML attribute values that are NOT Salesforce API references. */
const XML_BOILERPLATE_VALUES = new Set([
  'true', 'false', 'active', 'deleted', 'inactive', 'obsolete',
  'private', 'public', 'protected', 'global', 'readonly', 'readwrite',
  'standard', 'custom', 'required', 'optional', 'default',
  'enabled', 'disabled', 'hidden', 'visible', 'locked', 'unlocked',
  'none', 'all', 'always', 'never',
  'utf-8', 'utf8',
]);

function isXmlBoilerplate(value: string): boolean {
  const lower = value.toLowerCase();
  return XML_BOILERPLATE_VALUES.has(lower)
    || lower.startsWith('http') || lower.includes('xmlns')
    || /^v\d+/.test(lower)  // version strings like v62.0
    || /^\d/.test(lower);   // numeric-prefixed strings
}

// ─────────────────────────────────────────────────────────────────
// Main parse function
// ─────────────────────────────────────────────────────────────────

/**
 * Parse a single file and extract metadata references.
 * This is designed to be called from main thread or worker thread.
 */
export function parseFile(filePath: string, content: string, metadataType?: MetadataType): ParsedFile {
  const resolvedType = metadataType ?? classifyFile(filePath);
  const fileName = path.basename(filePath);
  const objectName = extractObjectName(filePath);
  const lines = content.split('\n');

  let parseResult: { refs: string[]; methods: string[]; lineRefs: LineReference[] };

  switch (resolvedType) {
    case MetadataType.ApexClass:
    case MetadataType.ApexTrigger:
      parseResult = parseApex(content, lines);
      break;

    case MetadataType.LWC:
      parseResult = parseLwc(content, lines);
      break;

    case MetadataType.Aura:
      parseResult = parseAura(content, lines);
      break;

    case MetadataType.Flow:
    case MetadataType.CustomObject:
    case MetadataType.CustomField:
    case MetadataType.CustomMetadata:
    case MetadataType.ValidationRule:
    case MetadataType.WorkflowRule:
    case MetadataType.PermissionSet:
    case MetadataType.Profile:
    case MetadataType.Layout:
    case MetadataType.CustomLabel:
    case MetadataType.FlexiPage:
    case MetadataType.EmailTemplate:
    case MetadataType.NamedCredential:
    case MetadataType.PlatformEvent:
    case MetadataType.ApprovalProcess:
    case MetadataType.SharingRule:
    case MetadataType.RecordType:
    case MetadataType.QuickAction:
    case MetadataType.GlobalValueSet:
    case MetadataType.CustomSetting:
      parseResult = parseXml(content, lines, resolvedType);
      break;

    case MetadataType.VisualforcePage:
    case MetadataType.VisualforceComponent:
      parseResult = parseVisualforce(content, lines);
      break;

    default:
      parseResult = { refs: [], methods: [], lineRefs: [] };
  }

  return {
    filePath,
    fileName,
    metadataType: resolvedType,
    objectName,
    content,
    references: parseResult.refs,
    methods: parseResult.methods,
    lineReferences: parseResult.lineRefs,
  };
}
