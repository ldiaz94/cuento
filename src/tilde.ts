/* Tilde the bookworm and the bookcloths spines are bound in: the
 * drawings the shelf and the year in review share. Depends on spark's
 * html. Leaves out how she moves: the page's style sways her head and
 * makes her blink. */
import { html } from './spark/index.js';

/** Bookcloth colours for spines: oxblood, navy, forest, ochre, teal,
 * plum, slate and rust. */
export const CLOTHS = [
  '#7d2f2b',
  '#26476e',
  '#2f5e4a',
  '#a27b2c',
  '#1f6164',
  '#5d3b66',
  '#4b5762',
  '#9b4b25',
];

/** A number for a string, the same every time (FNV-1a), so close ISBNs
 * still differ. */
export function hash(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 0x01000193);
  return h >>> 0;
}

/** A cloth for a spine, the same every time for the same book. */
export function cloth(isbn: string): string {
  return CLOTHS[hash(isbn) % CLOTHS.length] ?? '#7d2f2b';
}

/** Tilde, drawn in the page (icon.svg's drawing, in parts) so she can
 * move: her head sways on her neck and she blinks, while her book stays
 * still. */
export function tilde() {
  return html`<svg class="tilde" viewBox="0 0 256 256" width="128" height="128" aria-hidden="true">
    <path
      d="M176 190 C176 140 96 156 100 112"
      fill="none"
      stroke="#2b2620"
      stroke-width="44"
      stroke-linecap="round"
    />
    <path
      d="M176 190 C176 140 96 156 100 112"
      fill="none"
      stroke="#7fb069"
      stroke-width="34"
      stroke-linecap="round"
    />
    <path
      d="M150 150 C150 138 128 140 126 134"
      fill="none"
      stroke="#5a8a4a"
      stroke-width="6"
      stroke-linecap="round"
    />
    <g class="head">
      <g transform="rotate(28 150 70)">
        <rect
          x="144"
          y="18"
          width="12"
          height="62"
          rx="2"
          fill="#d9a21b"
          stroke="#2b2620"
          stroke-width="4"
        />
        <path
          d="M144 18 L150 4 L156 18 Z"
          fill="#f6f1e7"
          stroke="#2b2620"
          stroke-width="4"
          stroke-linejoin="round"
        />
        <rect
          x="144"
          y="70"
          width="12"
          height="10"
          fill="#b5532c"
          stroke="#2b2620"
          stroke-width="4"
        />
      </g>
      <circle cx="104" cy="88" r="42" fill="#7fb069" stroke="#2b2620" stroke-width="6" />
      <circle cx="141" cy="88" r="9" fill="#5a8a4a" stroke="#2b2620" stroke-width="4" />
      <circle cx="88" cy="86" r="14" fill="#fffdf8" stroke="#2b2620" stroke-width="5" />
      <circle cx="120" cy="86" r="14" fill="#fffdf8" stroke="#2b2620" stroke-width="5" />
      <path d="M102 85 H106" stroke="#2b2620" stroke-width="5" />
      <g class="eyes">
        <circle cx="90" cy="88" r="4.5" fill="#2b2620" />
        <circle cx="122" cy="88" r="4.5" fill="#2b2620" />
      </g>
      <path
        d="M90 108 Q104 120 118 108"
        fill="none"
        stroke="#2b2620"
        stroke-width="5"
        stroke-linecap="round"
      />
    </g>
    <rect
      x="44"
      y="176"
      width="168"
      height="56"
      rx="8"
      fill="#b5532c"
      stroke="#2b2620"
      stroke-width="6"
    />
    <path d="M72 176 V232 M184 176 V232" stroke="#d9a21b" stroke-width="6" />
    <rect
      x="92"
      y="192"
      width="80"
      height="24"
      rx="3"
      fill="#fffdf8"
      stroke="#2b2620"
      stroke-width="4"
    />
    <path d="M102 204 H162" stroke="#7a7064" stroke-width="4" stroke-linecap="round" />
  </svg>`;
}
