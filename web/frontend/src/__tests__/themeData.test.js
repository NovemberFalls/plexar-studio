import { describe, it, expect } from 'vitest';
import {
  THEMES,
  OVERRIDABLE_TOKENS,
  TOKEN_GROUPS,
  getTheme,
  listThemes,
  getSavedTheme,
  applyThemeToDOM,
  DEFAULT_THEME_ID,
} from '../themes/themeData.js';

const REQUIRED_PROPERTIES = [
  'id', 'label', 'group',
  'bg', 'bg2', 'surface', 'elev', 'term',
  'border', 'line',
  'fg', 'dim', 'muted',
  'accent',
  // 'kw' is deliberately absent: --cc-kw was removed from the token system —
  // no product surface ever read it, and it was theme-inconsistent.
  'fn', 'type', 'ok', 'macro', 'num',
  'working', 'thinking', 'waiting', 'idle', 'error',
];

describe('THEMES object', () => {
  it('exists and has entries', () => {
    expect(THEMES).toBeDefined();
    expect(typeof THEMES).toBe('object');
    const keys = Object.keys(THEMES);
    expect(keys.length).toBeGreaterThan(0);
  });

  it('has exactly 2 palettes (va-night, cockpit-blue)', () => {
    expect(Object.keys(THEMES).sort()).toEqual(['cockpit-blue', 'va-night']);
  });

  it('defaults to va-night', () => {
    expect(DEFAULT_THEME_ID).toBe('va-night');
  });
});

describe('theme properties', () => {
  const themeEntries = Object.entries(THEMES);

  it.each(themeEntries)(
    '%s has all required properties',
    (_id, theme) => {
      for (const prop of REQUIRED_PROPERTIES) {
        expect(theme).toHaveProperty(prop);
      }
    },
  );

  it.each(themeEntries)(
    '%s id matches its key in THEMES',
    (id, theme) => {
      expect(theme.id).toBe(id);
    },
  );
});

describe('getTheme', () => {
  it('returns a theme object for a valid id', () => {
    const theme = getTheme('va-night');
    expect(theme).toBeDefined();
    expect(theme.id).toBe('va-night');
  });

  it('returns null for an invalid id', () => {
    expect(getTheme('nonexistent-theme')).toBeNull();
  });
});

describe('listThemes', () => {
  it('returns an array with id, label, and group for each theme', () => {
    const list = listThemes();
    expect(Array.isArray(list)).toBe(true);
    expect(list).toHaveLength(Object.keys(THEMES).length);
    for (const entry of list) {
      expect(entry).toHaveProperty('id');
      expect(entry).toHaveProperty('label');
      expect(entry).toHaveProperty('group');
    }
  });
});

describe('getSavedTheme', () => {
  it('returns null when no theme is stored', () => {
    localStorage.clear();
    expect(getSavedTheme()).toBeNull();
  });
});

describe('applyThemeToDOM', () => {
  it('is a function', () => {
    expect(typeof applyThemeToDOM).toBe('function');
  });

  it('sets --cc-* CSS custom properties on document.documentElement', () => {
    const theme = THEMES['va-night'];
    applyThemeToDOM(theme);
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--cc-bg')).toBe(theme.bg);
    expect(style.getPropertyValue('--cc-accent')).toBe(theme.accent);
    expect(style.getPropertyValue('--cc-fg')).toBe(theme.fg);
    expect(style.getPropertyValue('--cc-working')).toBe(theme.accent);
  });

  it('applies an accent override to both --cc-accent and --cc-working', () => {
    const theme = THEMES['va-night'];
    applyThemeToDOM(theme, { accent: '#ff0000' });
    const style = document.documentElement.style;
    expect(style.getPropertyValue('--cc-accent')).toBe('#ff0000');
    expect(style.getPropertyValue('--cc-working')).toBe('#ff0000');
  });

  it('sets data-glow attribute based on glowEnabled option', () => {
    const theme = THEMES['va-night'];
    applyThemeToDOM(theme, { glowEnabled: false });
    expect(document.documentElement.getAttribute('data-glow')).toBe('off');
    applyThemeToDOM(theme, { glowEnabled: true });
    expect(document.documentElement.getAttribute('data-glow')).toBe('on');
  });

  it('does nothing when called with a falsy value', () => {
    // Should not throw
    expect(() => applyThemeToDOM(null)).not.toThrow();
    expect(() => applyThemeToDOM(undefined)).not.toThrow();
  });

  it('never writes --cc-kw: the token was removed, not just hidden', () => {
    for (const theme of Object.values(THEMES)) {
      applyThemeToDOM(theme);
      expect(document.documentElement.style.getPropertyValue('--cc-kw')).toBe('');
    }
  });

  it('applies every palette without throwing', () => {
    for (const theme of Object.values(THEMES)) {
      expect(() => applyThemeToDOM(theme, { accent: '#ff0000', glowStrength: 12 })).not.toThrow();
    }
  });
});

describe('--cc-kw removal', () => {
  it('is not an overridable token', () => {
    expect(OVERRIDABLE_TOKENS).not.toContain('--cc-kw');
  });

  it('leaves the syntax group as exactly type / macro / num', () => {
    const syntax = TOKEN_GROUPS.find((g) => g.id === 'syntax');
    expect(syntax.tokens).toEqual(['--cc-type', '--cc-macro', '--cc-num']);
  });

  it('is absent from every palette object', () => {
    for (const theme of Object.values(THEMES)) {
      expect(theme).not.toHaveProperty('kw');
    }
  });
});
