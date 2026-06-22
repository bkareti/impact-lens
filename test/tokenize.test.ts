import { describe, it, expect } from 'vitest';
import { preciseTokens, indexTokenize } from '../src/indexing/tokenize';

/**
 * `matches` models the default (precise) reference-graph matching: a query
 * matches a keyword when the query equals one of the keyword's precise tokens.
 */
function matches(query: string, keyword: string): boolean {
  return preciseTokens(keyword).includes(query.toLowerCase());
}

describe('preciseTokens', () => {
  it('emits a single token for a bare identifier', () => {
    expect(preciseTokens('Account')).toEqual(['account']);
  });

  it('emits dot segments for Object.Field', () => {
    const tokens = preciseTokens('Account.Name');
    expect(tokens).toContain('account.name');
    expect(tokens).toContain('account');
    expect(tokens).toContain('name');
  });

  it('emits underscore words and drops the __c suffix noise', () => {
    const tokens = preciseTokens('Account.Status__c');
    expect(tokens).toContain('account');
    expect(tokens).toContain('status__c');
    expect(tokens).toContain('status');
    expect(tokens).not.toContain('c'); // single-char suffix artifact dropped
  });

  it('does NOT camelCase-split — the headline precision guarantee', () => {
    expect(preciseTokens('AccountService')).toEqual(['accountservice']);
    expect(preciseTokens('AccountService')).not.toContain('account');
  });
});

describe('precise matching semantics', () => {
  it('"Account" matches Account and Account.Name', () => {
    expect(matches('Account', 'Account')).toBe(true);
    expect(matches('Account', 'Account.Name')).toBe(true);
  });

  it('"Account" does NOT match AccountService (no false positive)', () => {
    expect(matches('Account', 'AccountService')).toBe(false);
    expect(matches('Account', 'AccountId')).toBe(false);
  });

  it('"Status" matches a nested custom field', () => {
    expect(matches('Status', 'Account.Status__c')).toBe(true);
    expect(matches('Status__c', 'Account.Status__c')).toBe(true);
  });

  it('treats distinct identifiers as distinct (no substring leakage)', () => {
    expect(matches('getContacts', 'getContactsList')).toBe(false);
    expect(matches('getContacts', 'getContacts')).toBe(true);
  });
});

describe('indexTokenize (full-text recall)', () => {
  it('camelCase-splits to maximize recall, unlike preciseTokens', () => {
    const tokens = indexTokenize('AccountService');
    expect(tokens).toContain('account');
    expect(tokens).toContain('service');
  });

  it('splits Object.Field and underscores', () => {
    const tokens = indexTokenize('Account.Status__c');
    expect(tokens).toContain('account');
    expect(tokens).toContain('status');
  });
});
