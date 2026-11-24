import { describe, expect, it } from 'vitest';
import { pageFromHash } from './App';

describe('pageFromHash', () => {
  it('opens on the general page unless the caller asks for the services', () => {
    expect(pageFromHash('')).toBe('general');
    expect(pageFromHash('#general')).toBe('general');
    expect(pageFromHash('#services')).toBe('services');
    // Anything else (an old link, a typo) falls back to the general page.
    expect(pageFromHash('#engines')).toBe('general');
  });
});
