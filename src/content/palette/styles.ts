// The palette's shadow stylesheet (Design prototype, PaletteM3c board): every palette style
// lives here. A string only (the sheet is built at mount, so evaluating the module touches no
// DOM). Colors and the shadow come from tokens-isle.css, the only token file in the shadow;
// sizes, radii and type follow tokens.css and are written out as values, with the token named
// beside each group. `.r` resets what the page could pass down to the host. No `url(`
// anywhere: the module may not load resources by address.

/** tokens.css `--et-font-sans` (system fonts only). */
const SANS = '-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif';

// .sh the shadow that follows the shape, .sl the shape (clip-path, written per frame) holding
// .cn the content, placed at the final rectangle. Strip and rows: --et-h-strip 46,
// --et-h-control-lg 36; radii --et-radius-xl 14, -md 8, -xs 4, -full; spacing --et-space-1…4
// (4, 8, 12, 16); type --et-fs/lh-inject-lg 15/24, -md 13/20, -sm 12/18; weights 500, 600;
// --et-dur-fast 120ms. Text starts 40px in on both the input and the rows.
export const PALETTE_CSS = `
.r{all:initial;position:absolute;inset:0;pointer-events:none;font:13px/20px ${SANS};color:var(--et-color-isle-text);cursor:default;-webkit-font-smoothing:antialiased}
*{box-sizing:border-box}
[hidden]{display:none!important}
button{font:inherit;color:inherit;margin:0;padding:0;border:0;background:none;cursor:pointer}
svg{display:block;flex-shrink:0;fill:none;stroke:currentColor;stroke-width:1.5;stroke-linecap:round;stroke-linejoin:round}
.sh{position:absolute;left:0;top:0;border-radius:14px;box-shadow:var(--et-shadow-isle);pointer-events:none}
.sl{position:absolute;inset:0;background:var(--et-color-isle);clip-path:inset(50%);pointer-events:auto}
.r[data-anim] .sl{will-change:clip-path}
.r[data-anim] .sh,.r[data-anim] .cn{will-change:transform,opacity}
.cn{position:absolute;display:flex;flex-direction:column;max-height:calc(100vh - 32px);opacity:0}
.r[data-rm] .sl,.r[data-rm] .sh{animation:et-fade .12s ease-out}
.r[data-rm]{transition:opacity .12s}
@keyframes et-fade{from{opacity:0}}
.hd{display:flex;align-items:center;gap:8px;flex-shrink:0;height:46px;padding:0 16px}
.ld{position:relative;width:16px;height:16px;flex-shrink:0}
.ld::after{content:"";position:absolute;inset:3px;border-radius:50%;background:var(--et-color-accent)}
.r[data-halted] .ld::after{background:var(--et-color-isle-warn)}
.bk{display:flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:4px;color:var(--et-color-isle-dim)}
.bk:hover{color:var(--et-color-isle-text)}
.cp{display:flex;align-items:center;flex-shrink:0;height:24px;padding:0 8px;border-radius:999px;background:var(--et-color-isle-2);font-size:12px;line-height:18px;font-weight:500;white-space:nowrap}
.in{flex:1;min-width:0;height:24px;margin:0;padding:0;border:0;outline:0;background:none;color:inherit;font:15px/24px ${SANS};caret-color:var(--et-color-accent);appearance:none;-webkit-appearance:none}
.in::placeholder{color:var(--et-color-isle-dim)}
.hs{font-size:15px;line-height:24px}
.ls{flex:1 1 auto;min-height:0;max-height:296px;margin:0;padding:4px;list-style:none;overflow-y:auto;overscroll-behavior:contain;border-top:1px solid var(--et-color-isle-2);scrollbar-width:thin;scrollbar-color:color-mix(in oklab,var(--et-color-isle-dim) 40%,transparent) transparent}
.o,.em{display:flex;align-items:center;gap:8px;height:36px;padding:0 12px;border-radius:8px;font-size:13px;line-height:20px}
.o{cursor:pointer;user-select:none;-webkit-user-select:none}
.em{padding-left:36px;color:var(--et-color-isle-dim)}
.ic{display:flex;align-items:center;justify-content:center;width:16px;height:16px;flex-shrink:0;color:var(--et-color-isle-dim)}
.ic svg{width:16px;height:16px}
.pf{width:16px;height:16px;border:1px solid currentColor;border-radius:4px;font-size:10px;line-height:1;stroke-width:0}
.pi{width:16px;height:16px;flex-shrink:0;stroke:none}
.tt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hl{color:var(--et-color-accent)}
.o[aria-selected="true"]{background:var(--et-color-isle-2)}
.o[aria-selected="true"] .ic{color:var(--et-color-accent)}
.o[aria-disabled="true"]{cursor:default;color:var(--et-color-isle-dim)}
.o[aria-disabled="true"] .ic{opacity:.5}
.o[aria-current="true"] .tt{font-weight:500}
.o[data-warn] .ic,.nm{color:var(--et-color-isle-warn)}
.nm{font-weight:600;font-variant-numeric:tabular-nums}
.tr,.nt{flex-shrink:0;color:var(--et-color-isle-dim)}
.nt{font-size:12px}
.ok{width:14px;height:14px;color:var(--et-color-accent)}
.ch{width:14px;height:14px;color:var(--et-color-isle-dim)}
.kb{flex-shrink:0;margin-left:12px;font-size:12px;letter-spacing:.08em;color:var(--et-color-isle-dim)}
.kb:empty{display:none}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media print{.r{display:none}}
`;
