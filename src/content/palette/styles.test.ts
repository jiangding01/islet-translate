import { describe, expect, it } from 'vitest';
import { PALETTE_CSS } from './styles';

/** The declarations of the rule whose selector list is exactly `selector`. */
function rule(selector: string): string {
  const start = PALETTE_CSS.split('\n').find((line) => line.startsWith(`${selector}{`));
  if (!start) throw new Error(`no rule for ${selector}`);
  return start.slice(selector.length + 1, start.lastIndexOf('}'));
}

// happy-dom computes no layout: what keeps a long label from pushing the row apart is
// pinned here, in the rules themselves.
describe('palette styles', () => {
  it('centers the glyph box and sets its weight', () => {
    const pf = rule('.pf');
    expect(pf).toContain('display:flex');
    expect(pf).toContain('align-items:center');
    expect(pf).toContain('justify-content:center');
    expect(pf).toContain('box-sizing:border-box');
    expect(pf).toContain('font-weight:600');
  });

  it('lets the text label of an engine without an icon grow past 16px without wrapping', () => {
    const label = rule('.pi.pf');
    expect(label).toContain('min-width:16px');
    expect(label).toContain('white-space:nowrap');
    expect(label).toMatch(/^width:auto;/);
  });

  it('cuts a long trailing engine name or note with an ellipsis, keeping the title', () => {
    const trail = rule('.tr,.nt');
    expect(trail).toContain('max-width:45%');
    expect(trail).toContain('overflow:hidden');
    expect(trail).toContain('text-overflow:ellipsis');
    expect(trail).toContain('white-space:nowrap');
    expect(trail).toContain('flex-shrink:0');
    // The title takes the rest and is cut itself.
    const title = rule('.tt');
    expect(title).toContain('flex:1');
    expect(title).toContain('min-width:0');
    expect(title).toContain('text-overflow:ellipsis');
  });

  it('keeps the halted strip on one line, cut with an ellipsis', () => {
    const strip = rule('.hs');
    expect(strip).toContain('white-space:nowrap');
    expect(strip).toContain('overflow:hidden');
    expect(strip).toContain('text-overflow:ellipsis');
    expect(strip).toContain('min-width:0');
  });

  it('sets the trailing count, note and shortcut at 12px', () => {
    expect(rule('.nm')).toContain('font-size:12px');
    expect(rule('.tr,.nt')).toContain('font-size:12px');
    expect(rule('.kb')).toContain('font-size:12px');
  });

  it('quick translate: a result of at most 168px that scrolls and fades, a 28px footnote', () => {
    const result = rule('.qr');
    expect(result).toContain('max-height:168px');
    expect(result).toContain('padding:12px 16px');
    expect(result).toContain('gap:6px');
    expect(result).toContain('border-top:1px solid var(--et-color-isle-2)');
    expect(rule('.qt')).toContain('overflow-y:auto');
    expect(rule('.qt')).toContain('user-select:text');
    expect(rule('.qt[data-more]')).toContain('calc(100% - 22px)');
    expect(rule('.qt::selection,.qt ::selection')).toContain(
      'color-mix(in oklab,var(--et-color-accent) 38%,transparent)',
    );
    const foot = rule('.ft');
    expect(foot).toContain('height:28px');
    expect(foot).toContain('font-size:11px');
    // Its text starts where the row titles do.
    expect(foot).toContain('padding:0 16px 0 40px');
    // The translate row cuts the text between the quotes, never the closing quote.
    expect(rule('.q')).toContain('text-overflow:ellipsis');
    expect(rule('.q')).toContain('min-width:0');
    expect(rule('.ic .cd')).toContain('var(--et-color-isle-ok)');
  });

  it('shows a fainter hover only while the pointer does not move the highlight', () => {
    expect(rule('.o[aria-selected="true"]')).toContain('background:var(--et-color-isle-2)');
    expect(rule('.ls[data-hover] .o:hover:not([aria-disabled="true"])')).toContain(
      'background:color-mix(in oklab,var(--et-color-isle-2) 50%,transparent)',
    );
    // No hover rule for every state: it would show a second highlight.
    expect(PALETTE_CSS).not.toMatch(/(^|[,}])\.o:hover/m);
  });
});
