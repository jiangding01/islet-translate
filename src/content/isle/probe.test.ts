// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from 'vitest';
import {
  AVOID_GAP,
  avoid,
  findBanner,
  findObstacles,
  type Obstacle,
  type ProbeEnv,
  parseColor,
  pinnedAncestor,
  probeTheme,
} from './probe';

const VP = { w: 1000, h: 800 };

interface Fake {
  position?: string;
  bottom?: string;
  background?: string;
  scheme?: string;
  rect?: { top: number; bottom: number; left: number; right: number };
}

function setup(hits: (x: number, y: number) => Element[], prefersDark = false) {
  const styles = new Map<Element, Fake>();
  const host = document.createElement('et-isle');
  document.documentElement.append(host);
  const env: ProbeEnv = {
    elementsFromPoint: hits,
    getComputedStyle: (element) => {
      const fake = styles.get(element) ?? {};
      return {
        position: fake.position ?? 'static',
        bottom: fake.bottom ?? 'auto',
        backgroundColor: fake.background ?? 'rgba(0, 0, 0, 0)',
        colorScheme: fake.scheme ?? 'normal',
      };
    },
    host,
    prefersDark: () => prefersDark,
  };
  const fake = (element: Element, value: Fake) => {
    styles.set(element, value);
    if (value.rect) {
      const { top, bottom, left, right } = value.rect;
      element.getBoundingClientRect = () =>
        ({
          top,
          bottom,
          left,
          right,
          x: left,
          y: top,
          width: right - left,
          height: bottom - top,
        }) as DOMRect;
    }
    return element;
  };
  return { env, host, fake };
}

beforeEach(() => {
  document.body.innerHTML = '';
  for (const element of document.documentElement.querySelectorAll('et-isle')) element.remove();
});

describe('pinnedAncestor', () => {
  it('walks up from a child (or an iframe) to the fixed or sticky container', () => {
    const { env, fake } = setup(() => []);
    const bubble = fake(document.createElement('div'), { position: 'fixed' });
    const frame = document.createElement('iframe');
    bubble.append(frame);
    document.body.append(bubble);
    expect(pinnedAncestor(env, frame)).toBe(bubble);
    const sticky = fake(document.createElement('nav'), { position: 'sticky' });
    document.body.append(sticky);
    expect(pinnedAncestor(env, sticky)).toBe(sticky);
    const plain = document.createElement('p');
    document.body.append(plain);
    expect(pinnedAncestor(env, plain)).toBeUndefined();
  });
});

describe('findObstacles', () => {
  it('finds widgets in the band, skips the host and ignores full-length bars', () => {
    const bubble = document.createElement('div');
    const icon = document.createElement('span');
    bubble.append(icon);
    const sidebar = document.createElement('aside');
    document.body.append(bubble, sidebar);
    const { env, host, fake } = setup((_x, y) => {
      if (y >= 440 && y <= 500) return [host, icon, document.body];
      if (y > 560) return [sidebar];
      return [host, document.body];
    });
    fake(bubble, { position: 'fixed', rect: { top: 440, bottom: 500, left: 920, right: 980 } });
    // Taller than half the edge: nowhere to step around it.
    fake(sidebar, { position: 'fixed', rect: { top: 0, bottom: 800, left: 960, right: 1000 } });
    const found = findObstacles(env, 'right', VP, { depths: [21, 36], offset: 480, length: 200 });
    // Center: 50px in from the right edge; 60px deep (its own width on a side dock).
    expect(found).toEqual([{ lo: 440, hi: 500, center: 50, depth: 60 }]);
  });

  it('looks through the selection card host as it does through its own', () => {
    const bubble = document.createElement('div');
    const icon = document.createElement('span');
    bubble.append(icon);
    document.body.append(bubble);
    const card = document.createElement('et-selection');
    document.documentElement.append(card);
    try {
      const { env, fake } = setup((_x, y) => (y >= 440 && y <= 500 ? [card, icon] : [card]));
      fake(bubble, { position: 'fixed', rect: { top: 440, bottom: 500, left: 920, right: 980 } });
      expect(
        findObstacles(env, 'right', VP, { depths: [21, 36], offset: 480, length: 200 }),
      ).toEqual([{ lo: 440, hi: 500, center: 50, depth: 60 }]);
    } finally {
      card.remove();
    }
  });

  it('looks through the palette host as well', () => {
    const bubble = document.createElement('div');
    const icon = document.createElement('span');
    bubble.append(icon);
    document.body.append(bubble);
    const palette = document.createElement('et-palette');
    document.documentElement.append(palette);
    try {
      const { env, fake } = setup((_x, y) => (y >= 440 && y <= 500 ? [palette, icon] : [palette]));
      fake(bubble, { position: 'fixed', rect: { top: 440, bottom: 500, left: 920, right: 980 } });
      expect(
        findObstacles(env, 'right', VP, { depths: [21, 36], offset: 480, length: 200 }),
      ).toEqual([{ lo: 440, hi: 500, center: 50, depth: 60 }]);
    } finally {
      palette.remove();
    }
  });

  it('samples leftward of the right end for the bottom dock', () => {
    const chat = document.createElement('div');
    document.body.append(chat);
    const seen: [number, number][] = [];
    const { env, fake } = setup((x, y) => {
      seen.push([x, y]);
      return x >= 560 && x <= 600 ? [chat] : [];
    });
    fake(chat, { position: 'fixed', rect: { top: 720, bottom: 780, left: 560, right: 600 } });
    // Right end at 700: the band covers [500, 700].
    expect(findObstacles(env, 'bottom', VP, { depths: [36], offset: 700, length: 200 })).toEqual([
      { lo: 560, hi: 600, center: 50, depth: 60 },
    ]);
    expect(seen.every(([, y]) => y === VP.h - 36)).toBe(true);
    expect(Math.min(...seen.map(([x]) => x))).toBe(500);
    expect(Math.max(...seen.map(([x]) => x))).toBeGreaterThan(700 - 24);
    expect(Math.max(...seen.map(([x]) => x))).toBeLessThanOrEqual(700);
  });
});

describe('findBanner', () => {
  const banner = (rect: Fake['rect'], position = 'fixed', bottom = 'auto') => {
    const element = document.createElement('div');
    const text = document.createElement('span');
    element.append(text);
    document.body.append(element);
    const seen: [number, number][] = [];
    const probe = setup((x, y) => {
      seen.push([x, y]);
      return [probe.host, text, element, document.body];
    });
    probe.fake(element, { position, rect, bottom });
    return { ...probe, seen };
  };

  it('measures a fixed or bottom-sticky full-width bar along the bottom, up to 30% tall', () => {
    const fixed = banner({ top: 744, bottom: 800, left: 0, right: 1000 });
    expect(findBanner(fixed.env, 'bottom', VP)).toBe(56);
    expect(fixed.seen.every(([, y]) => y === VP.h - 1)).toBe(true);
    // Wider than half the viewport is enough; 30% of 800 is the tallest one risen over.
    const sticky = banner({ top: 560, bottom: 800, left: 300, right: 1000 }, 'sticky', '0px');
    expect(findBanner(sticky.env, 'bottom', VP)).toBe(240);
    // Within a pixel of the bottom edge counts as touching it.
    const near = banner({ top: 743.5, bottom: 799.5, left: 0, right: 1000 });
    expect(findBanner(near.env, 'bottom', VP)).toBe(56.5);
  });

  it('judges a banner by its own height, not the part showing in the viewport', () => {
    // A tall bottom-sticky block scrolling in: 200px show, 800px tall.
    expect(
      findBanner(
        banner({ top: 600, bottom: 1400, left: 0, right: 1000 }, 'sticky', '0px').env,
        'bottom',
        VP,
      ),
    ).toBe(0);
    // A fixed panel reaching above the viewport.
    expect(
      findBanner(banner({ top: -100, bottom: 800, left: 0, right: 1000 }).env, 'bottom', VP),
    ).toBe(0);
  });

  it('ignores a top-sticky header just scrolled in from below', () => {
    // `position: sticky; top: 0`, not stuck: it only happens to sit at the bottom.
    expect(
      findBanner(
        banner({ top: 770, bottom: 800, left: 0, right: 1000 }, 'sticky', 'auto').env,
        'bottom',
        VP,
      ),
    ).toBe(0);
  });

  it('ignores a centered bottom bar that leaves the dot column free', () => {
    const centered = banner({ top: 744, bottom: 800, left: 200, right: 800 });
    expect(findBanner(centered.env, 'bottom', VP)).toBe(0);
    // One reaching the dot column is risen over.
    const wide = banner({ top: 744, bottom: 800, left: 200, right: 1000 });
    expect(findBanner(wide.env, 'bottom', VP)).toBe(56);
  });

  it('ignores taller panels, narrow widgets, bars off the bottom edge and static ones', () => {
    expect(
      findBanner(banner({ top: 559, bottom: 800, left: 0, right: 1000 }).env, 'bottom', VP),
    ).toBe(0);
    expect(
      findBanner(banner({ top: 744, bottom: 800, left: 600, right: 1000 }).env, 'bottom', VP),
    ).toBe(0);
    expect(
      findBanner(banner({ top: 700, bottom: 780, left: 0, right: 1000 }).env, 'bottom', VP),
    ).toBe(0);
    expect(
      findBanner(
        banner({ top: 744, bottom: 800, left: 0, right: 1000 }, 'static').env,
        'bottom',
        VP,
      ),
    ).toBe(0);
  });

  it('leaves the side docks alone', () => {
    for (const dock of ['right', 'left'] as const) {
      const probe = banner({ top: 744, bottom: 800, left: 0, right: 1000 });
      expect(findBanner(probe.env, dock, VP)).toBe(0);
      expect(probe.seen).toEqual([]);
    }
  });
});

describe('avoid', () => {
  const ob = (lo: number, hi: number, center = 30): Obstacle => ({ lo, hi, center, depth: 40 });
  // A side edge 800px long.
  const side = (preferred: number, length: number, obstacles: Obstacle[]) =>
    avoid(preferred, length, obstacles, 'right', VP);

  it('keeps the preferred offset when nothing is in the way', () => {
    expect(side(480, 200, [])).toEqual({ offset: 480 });
    expect(side(480, 200, [ob(100, 150)])).toEqual({ offset: 480 });
  });

  it('steps to the nearest side of a widget, leaving the gap, and names it', () => {
    // Widget just below the middle: going up is shorter.
    const below = ob(540, 600);
    expect(side(480, 200, [below])).toEqual({ offset: 540 - AVOID_GAP - 100, obstacle: below });
    // Widget above the middle: going down is shorter.
    expect(side(480, 200, [ob(360, 420)]).offset).toBe(420 + AVOID_GAP + 100);
  });

  it('stays inside the edge, and gives up (clamped) when nothing fits', () => {
    // Below would leave the viewport: go above.
    expect(side(700, 200, [ob(600, 660)]).offset).toBe(600 - AVOID_GAP - 100);
    expect(side(400, 600, [ob(300, 500)])).toEqual({ offset: 400 });
  });

  it('keeps a right-anchored bottom isle to the left of a corner widget', () => {
    // A chat bubble in the bottom-right corner, 52px wide, 20px from the edges.
    const bubble = ob(928, 980, 46);
    const result = avoid(984, 240, [bubble], 'bottom', VP);
    // Right end 8px left of the bubble; going right of it would leave the viewport.
    expect(result).toEqual({ offset: 928 - AVOID_GAP, obstacle: bubble });
    // Room on the right: the nearer side wins.
    const left = ob(700, 730);
    expect(avoid(984, 240, [left], 'bottom', VP)).toEqual({ offset: 984 });
    expect(avoid(900, 240, [left], 'bottom', VP)).toEqual({
      offset: 730 + AVOID_GAP + 240,
      obstacle: left,
    });
  });
});

describe('parseColor', () => {
  it('reads the formats computed styles produce', () => {
    expect(parseColor('rgba(0, 0, 0, 0)')?.alpha).toBe(0);
    expect(parseColor('transparent')?.alpha).toBe(0);
    expect(parseColor('rgb(255, 255, 255)')).toEqual({ luminance: 1, alpha: 1 });
    expect(parseColor('rgb(0 0 0 / 50%)')).toEqual({ luminance: 0, alpha: 0.5 });
    expect(parseColor('rgb(18, 18, 18)')?.luminance).toBeLessThan(0.02);
    expect(parseColor('oklch(0.2 0.01 70)')?.luminance).toBeCloseTo(0.008, 3);
    expect(parseColor('oklch(98% 0.01 70)')?.luminance).toBeGreaterThan(0.9);
    expect(parseColor('color(srgb 1 1 1 / 0.2)')).toEqual({ luminance: 1, alpha: 0.2 });
    expect(parseColor('lab(20 0 0)')?.luminance).toBeLessThan(0.05);
    expect(parseColor('var(--x)')).toBeUndefined();
  });
});

describe('probeTheme', () => {
  it('finds a dark background painted on a wrapper under transparent html and body', () => {
    const app = document.createElement('div');
    const text = document.createElement('p');
    app.append(text);
    document.body.append(app);
    const { env, host, fake } = setup(() => [host, text, app, document.body]);
    fake(app, { background: 'rgb(15, 17, 21)' });
    expect(probeTheme(env, 10, 10, document.documentElement)).toBe('dark');
    fake(app, { background: 'rgb(250, 250, 250)' });
    expect(probeTheme(env, 10, 10, document.documentElement)).toBe('light');
  });

  it('skips faint backgrounds and falls back to the root color-scheme, then light', () => {
    const { env, fake } = setup(() => [document.body]);
    fake(document.body, { background: 'rgba(0, 0, 0, 0.1)' });
    expect(probeTheme(env, 1, 1, document.documentElement)).toBe('light');
    fake(document.documentElement, { scheme: 'dark' });
    expect(probeTheme(env, 1, 1, document.documentElement)).toBe('dark');
    fake(document.documentElement, { scheme: 'light dark' });
    expect(probeTheme(env, 1, 1, document.documentElement)).toBe('light');
    const dark = setup(() => [document.body], true);
    dark.fake(document.documentElement, { scheme: 'light dark' });
    expect(probeTheme(dark.env, 1, 1, document.documentElement)).toBe('dark');
  });
});
