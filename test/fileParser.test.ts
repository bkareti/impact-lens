import { describe, it, expect } from 'vitest';
import { classifyFile, extractObjectName, parseFile } from '../src/indexing/fileParser';
import { MetadataType } from '../src/models/searchResult';

describe('classifyFile', () => {
  it('classifies Apex classes and triggers', () => {
    expect(classifyFile('force-app/main/default/classes/MyController.cls')).toBe(MetadataType.ApexClass);
    expect(classifyFile('force-app/main/default/triggers/AccountTrigger.trigger')).toBe(MetadataType.ApexTrigger);
  });

  it('classifies LWC and Aura by folder', () => {
    expect(classifyFile('force-app/main/default/lwc/myCmp/myCmp.js')).toBe(MetadataType.LWC);
    expect(classifyFile('force-app/main/default/aura/myCmp/myCmp.cmp')).toBe(MetadataType.Aura);
  });

  it('classifies object metadata', () => {
    expect(classifyFile('force-app/main/default/objects/Account/fields/Status__c.field-meta.xml')).toBe(MetadataType.CustomField);
    expect(classifyFile('force-app/main/default/objects/Account/Account.object-meta.xml')).toBe(MetadataType.CustomObject);
  });

  it('returns Unknown for unrelated files', () => {
    expect(classifyFile('README.md')).toBe(MetadataType.Unknown);
  });
});

describe('extractObjectName', () => {
  it('extracts the parent object from a field path', () => {
    expect(extractObjectName('force-app/main/default/objects/Account/fields/Status__c.field-meta.xml')).toBe('Account');
  });

  it('returns empty string when no object segment is present', () => {
    expect(extractObjectName('force-app/main/default/classes/MyController.cls')).toBe('');
  });
});

describe('parseFile (Apex)', () => {
  const apex = [
    'public class AccountService {',
    '  public List<Account> getActive() {',
    '    return [SELECT Id, Status__c FROM Account WHERE Status__c = \'Active\'];',
    '  }',
    '}',
  ].join('\n');

  const parsed = parseFile('force-app/main/default/classes/AccountService.cls', apex, MetadataType.ApexClass);

  it('extracts the SObject from the SOQL FROM clause', () => {
    expect(parsed.references).toContain('Account');
  });

  it('extracts the custom field reference', () => {
    expect(parsed.references).toContain('Status__c');
  });

  it('records line-level references with 1-based line numbers', () => {
    const fieldRef = parsed.lineReferences.find((r) => r.keyword === 'Status__c');
    expect(fieldRef).toBeDefined();
    expect(fieldRef!.line).toBe(3);
  });
});
