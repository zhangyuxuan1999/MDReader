// test/app.tokens.test.ts — colour tokens must pass WCAG AA for body-sized text (finding r3:
// "Code-comment syntax colour fails WCAG AA contrast in both themes (light 2.77:1)"). Comments in
// fenced code are the smallest, densest text in the app; hljs.css maps .hljs-comment → --hl-comment
// and the effective background there is --mdr-code-bg.
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const css = readFileSync(resolve(process.cwd(), 'src/styles/tokens.css'), 'utf8');

/** The declarations of one rule, as a name → value map. */
function block(selector: string): Record<string, string> {
  const i = css.indexOf(`\n${selector} {`);
  expect(i, `rule ${selector} not found in tokens.css`).toBeGreaterThan(-1);
  const body = css.slice(i, css.indexOf('\n}', i));
  const out: Record<string, string> = {};
  for (const m of body.matchAll(/(--[a-z-]+)\s*:\s*([^;]+);/g)) out[m[1]] = m[2].trim();
  return out;
}

function relLuminance(hex: string): number {
  const h = hex.replace('#', '');
  expect(h, `expected a 6-digit hex colour, got ${hex}`).toMatch(/^[0-9a-fA-F]{6}$/);
  const ch = [0, 2, 4].map((i) => {
    const v = parseInt(h.slice(i, i + 2), 16) / 255;
    return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
  });
  return 0.2126 * ch[0] + 0.7152 * ch[1] + 0.0722 * ch[2];
}
export function contrast(fg: string, bg: string): number {
  const a = relLuminance(fg);
  const b = relLuminance(bg);
  const [hi, lo] = a > b ? [a, b] : [b, a];
  return (hi + 0.05) / (lo + 0.05);
}

const AA = 4.5;

describe('tokens.css contrast', () => {
  for (const [theme, selector] of [['light', ':root'], ['dark', ':root[data-theme="dark"]']] as const) {
    it(`[${theme}] syntax colours on --mdr-code-bg reach WCAG AA`, () => {
      const t = block(selector);
      const bg = t['--mdr-code-bg'];
      expect(bg).toBeTruthy();
      // Comment was the worst (2.77:1 in light); meta / string / number / attr / addition also sat below AA.
      const names = Object.keys(t).filter((n) => n.startsWith('--hl-')).concat('--mdr-code-fg');
      expect(names.length).toBeGreaterThan(10);
      for (const name of names) {
        const ratio = contrast(t[name], bg);
        expect(ratio, `${theme} ${name} ${t[name]} on ${bg} = ${ratio.toFixed(2)}:1`).toBeGreaterThanOrEqual(AA);
      }
    });

    it(`[${theme}] --hl-comment is still visibly muted against the code foreground`, () => {
      const t = block(selector);
      // AA must not be bought by turning comments into ordinary code text.
      expect(contrast(t['--hl-comment'], t['--mdr-code-bg'])).toBeLessThan(contrast(t['--mdr-code-fg'], t['--mdr-code-bg']));
    });
  }
});
