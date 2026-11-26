import { describe, expect, it } from 'vitest';
import { pageFromHash } from './App';

describe('pageFromHash', () => {
  it('opens on the general page unless the caller asks for another page', () => {
    expect(pageFromHash('')).toBe('general');
    expect(pageFromHash('#general')).toBe('general');
    expect(pageFromHash('#services')).toBe('services');
    expect(pageFromHash('#styles')).toBe('styles');
    expect(pageFromHash('#glossary')).toBe('glossary');
    // Anything else (an old link, a typo) falls back to the general page.
    expect(pageFromHash('#engines')).toBe('general');
  });
});
