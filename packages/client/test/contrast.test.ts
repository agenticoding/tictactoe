// @vitest-environment node
// Must run under node: it reads index.css from disk via fileURLToPath, which
// jsdom's http-style import.meta.url cannot resolve.
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

// The two style-sheet separators: tailwind color tokens live as `--color-<name>: <hex>`.
const css = readFileSync(fileURLToPath(new URL('../src/index.css', import.meta.url)), 'utf-8');

/** Parse every `--color-<name>: <hex>` declaration from the stylesheet. */
function parseTokens(source: string): Record<string, string> {
  const tokens: Record<string, string> = {};
  const re = /--color-([\w-]+)\s*:\s*(#[0-9a-fA-F]{6})\s*;/g;
  for (let m = re.exec(source); m !== null; m = re.exec(source)) tokens[m[1]!] = m[2]!.toLowerCase();
  return tokens;
}

function channel(value: number): number {
  const s = value / 255;
  return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
}

/** WCAG relative luminance of a `#rrggbb` hex color, in [0, 1]. */
function luminance(hex: string): number {
  const n = parseInt(hex.slice(1), 16);
  return 0.2126 * channel((n >> 16) & 255) + 0.7152 * channel((n >> 8) & 255) + 0.0722 * channel(n & 255);
}

/** WCAG contrast ratio between two hex colors, in [1, 21]. */
function contrast(a: string, b: string): number {
  const la = luminance(a);
  const lb = luminance(b);
  const [hi, lo] = la > lb ? [la, lb] : [lb, la];
  return (hi + 0.05) / (lo + 0.05);
}

describe('verified palette contrast (WCAG AA)', () => {
  const tokens = parseTokens(css);
  const require = (name: string): string => {
    const value = tokens[name];
    if (value === undefined) throw new Error(`palette token --color-${name} not found in index.css`);
    return value;
  };
  const page = require('page');
  const text = require('text');
  const status = require('status');
  const markX = require('mark-x');
  const markO = require('mark-o');
  const grid = require('grid');
  const cell = require('cell');
  const focus = require('focus');
  const error = require('error');
  const errorBg = require('error-bg');

  it('text/foreground pairs meet 4.5:1', () => {
    const pairs: Array<[string, string, string]> = [
      ['text', text, page], // body text on page background
      ['status', status, page], // status line on page background
      ['X mark', markX, cell], // X mark on a cell
      ['O mark', markO, cell], // O mark on a cell
      ['error text', error, errorBg], // error copy on the alert background
    ];
    for (const [label, fg, bg] of pairs) {
      expect(contrast(fg, bg), `${label} (${fg} on ${bg})`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('UI / boundary pairs meet 3:1', () => {
    const pairs: Array<[string, string, string]> = [
      ['board grid', grid, cell], // board background against its white cells
      ['focus ring', focus, cell], // keyboard focus ring against a cell
    ];
    for (const [label, fg, bg] of pairs) {
      expect(contrast(fg, bg), `${label} (${fg} on ${bg})`).toBeGreaterThanOrEqual(3);
    }
  });
});
