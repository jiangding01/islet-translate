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
// --et-dur-fast 120ms. Text starts 40px in on both the input and the rows (and the footnote).
// Quick translate (PR3): .qr the result above the list (padding --et-space-3/4, gap 6, at most
// 168 tall), .dr its direction line (-sm 12/18), .qt the selectable translation (-lg 15/24)
// with the card's caret and bottom fade; .ft the footnote (28 tall, --et-fs-inject-xs 11);
// .arc the lead's spinning ring while a request runs (the isle's .arc, 1.5px).
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
.arc{position:absolute;inset:0;width:16px;height:16px;color:var(--et-color-accent);opacity:0;transform-origin:50% 50%;transition:opacity .2s}
.arc path:last-child{stroke-dasharray:12 34}
.r[data-run] .arc{opacity:1;animation:et-spin 1s linear infinite}
@keyframes et-spin{to{transform:rotate(360deg)}}
.bk{display:flex;align-items:center;justify-content:center;width:16px;height:16px;border-radius:4px;color:var(--et-color-isle-dim)}
.bk:hover{color:var(--et-color-isle-text)}
.cp{display:flex;align-items:center;flex-shrink:0;height:24px;padding:0 8px;border-radius:999px;background:var(--et-color-isle-2);font-size:12px;line-height:18px;font-weight:500;white-space:nowrap}
.in{flex:1;min-width:0;height:24px;margin:0;padding:0;border:0;outline:0;background:none;color:inherit;font:15px/24px ${SANS};caret-color:var(--et-color-accent);appearance:none;-webkit-appearance:none}
.in::placeholder{color:var(--et-color-isle-dim)}
.hs{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.qr{display:flex;flex-direction:column;gap:6px;flex-shrink:0;max-height:168px;padding:12px 16px;border-top:1px solid var(--et-color-isle-2)}
.dr{display:flex;align-items:center;gap:4px;flex-shrink:0;font-size:12px;line-height:18px;color:var(--et-color-isle-dim);white-space:nowrap}
.dr svg{width:12px;height:12px}
.qt{min-height:0;overflow-y:auto;overscroll-behavior:contain;outline:0;font-size:15px;line-height:24px;letter-spacing:.01em;white-space:pre-wrap;overflow-wrap:anywhere;user-select:text;-webkit-user-select:text;cursor:text;scrollbar-width:thin;scrollbar-color:color-mix(in oklab,var(--et-color-isle-dim) 40%,transparent) transparent}
.qt::selection,.qt ::selection{background:color-mix(in oklab,var(--et-color-accent) 38%,transparent)}
.qt[data-more]{mask-image:linear-gradient(#000 calc(100% - 22px),transparent)}
.cr{display:inline-block;width:2px;height:15px;margin-left:2px;vertical-align:-2px;border-radius:1px;background:var(--et-color-accent);animation:et-pulse 1s ease-in-out infinite}
@keyframes et-pulse{50%{opacity:.25}}
.nc{margin:0;font-size:13px;line-height:20px;letter-spacing:0;white-space:normal;color:var(--et-color-isle-dim)}
.nc[data-err]{color:var(--et-color-isle-text)}
.nc[data-err]::before{content:"";display:inline-block;width:6px;height:6px;margin-right:8px;border-radius:50%;vertical-align:2px;background:var(--et-color-isle-warn)}
.ls{flex:1 1 auto;min-height:0;max-height:296px;margin:0;padding:4px;list-style:none;overflow-y:auto;overscroll-behavior:contain;border-top:1px solid var(--et-color-isle-2);scrollbar-width:thin;scrollbar-color:color-mix(in oklab,var(--et-color-isle-dim) 40%,transparent) transparent}
.o,.em{display:flex;align-items:center;gap:8px;height:36px;padding:0 12px;border-radius:8px;font-size:13px;line-height:20px}
.o{cursor:pointer;user-select:none;-webkit-user-select:none}
.em{padding-left:36px;color:var(--et-color-isle-dim)}
.ic{display:flex;align-items:center;justify-content:center;width:16px;height:16px;flex-shrink:0;color:var(--et-color-isle-dim)}
.ic svg{width:16px;height:16px}
.pf{display:flex;align-items:center;justify-content:center;box-sizing:border-box;width:16px;height:16px;border:1px solid currentColor;border-radius:4px;font-size:10px;line-height:1;font-weight:600;stroke-width:0}
.pi{width:16px;height:16px;flex-shrink:0;stroke:none}
.pi.pf{width:auto;min-width:16px;padding:0 2px;font-size:9px;white-space:nowrap}
.tt{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.hl{color:var(--et-color-accent)}
.qq{display:flex}
.q{min-width:0;overflow:hidden;text-overflow:ellipsis}
.ic .cd{color:var(--et-color-isle-ok)}
.o[aria-selected="true"]{background:var(--et-color-isle-2)}
.ls[data-hover] .o:hover:not([aria-disabled="true"]){background:color-mix(in oklab,var(--et-color-isle-2) 50%,transparent)}
.o[aria-selected="true"] .ic{color:var(--et-color-accent)}
.o[aria-disabled="true"]{cursor:default;color:var(--et-color-isle-dim)}
.o[aria-disabled="true"] .ic{opacity:.5}
.o[aria-current="true"] .tt{font-weight:500}
.o[data-warn] .ic,.nm{color:var(--et-color-isle-warn)}
.nm{font-size:12px;line-height:18px;font-weight:600;font-variant-numeric:tabular-nums}
.tr,.nt{flex-shrink:0;max-width:45%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px;line-height:18px;color:var(--et-color-isle-dim)}
.ok{width:14px;height:14px;color:var(--et-color-accent)}
.ch{width:14px;height:14px;margin-right:-4px;color:var(--et-color-isle-dim)}
.tr+.ch{margin-left:-4px}
.kb{flex-shrink:0;margin-left:12px;font-size:12px;letter-spacing:.08em;font-variant-numeric:tabular-nums;color:var(--et-color-isle-dim)}
.kb:empty{display:none}
.ft{display:flex;align-items:center;flex-shrink:0;height:28px;padding:0 16px 0 40px;font-size:11px;line-height:16px;color:var(--et-color-isle-dim);white-space:nowrap;overflow:hidden}
.r[data-rm] .arc,.r[data-rm] .cr{animation:none}
@media (prefers-reduced-motion:reduce){.arc,.cr{animation:none!important}}
.sr{position:absolute;width:1px;height:1px;overflow:hidden;clip-path:inset(50%);white-space:nowrap}
@media print{.r{display:none}}
`;
