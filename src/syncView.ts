/* Sync's part of the Settings sheet: turning sync on, joining a shelf
 * with a code, and, once on, how it goes, the code, its link (copied,
 * shared, or as a QR code for a phone's camera) and stopping.
 *
 *   off:  what sync is ── Turn on sync ── a code? [______] Join
 *   on:   In sync ── 7KQ2-…-XY ── QR ── Copy link, Share ── Stop
 *
 * Signed in (account.ts), sync is the account's: the code, link and QR
 * fold under "Share this shelf", since a passkey finds the shelf; a
 * device syncing no shelf, or another one, is offered the account's, or
 * to make its own the account's.
 *
 * The QR code is drawn by qrcode-generator (MIT), self-hosted in
 * vendor/qrcode/ (robbie qrcode) and fetched only when shown. Depends on
 * spark, sync.ts and account.ts. Leaves out scanning a QR code in cuento
 * (the phone's camera app opens the link). */
import { signal, html } from './spark/index.js';
import { status, code, enable, join, leave, link, grouped } from './sync.ts';
import type { SyncStatus } from './sync.ts';
import { me, adopt } from './account.ts';

/** Where qrcode-generator is vendored, beside this file once built. */
const QR = './vendor/qrcode/qrcode.mjs';
/** Blank modules around a QR code, as the standard asks. */
const QUIET = 4;

/** The part of qrcode-generator used here. */
interface QrCode {
  addData(data: string): void;
  make(): void;
  getModuleCount(): number;
  isDark(row: number, col: number): boolean;
}
/** qrcode-generator's module: a code of a size (0: the smallest that
 * fits) and error correction level. */
interface QrModule {
  default(size: 0, level: 'L' | 'M' | 'Q' | 'H'): QrCode;
}

/** What each status says, once sync is on. */
const SAID: Record<SyncStatus, string> = {
  off: '',
  syncing: 'Syncing',
  synced: 'In sync',
  offline: 'Offline: changes wait here until you are back online.',
  error: 'Could not sync just now; cuento will try again.',
};

/** What the input an event came from holds. */
const valueOf = (e: Event) => (e.target as HTMLInputElement).value;

/** The Sync section of Settings. */
export function syncSection(): Node {
  const [trouble, setTrouble] = signal('');
  const [busy, setBusy] = signal(false);
  /** Runs what a button does, showing what went wrong, if anything. */
  const act = async (what: () => Promise<void>) => {
    setBusy(true);
    setTrouble('');
    try {
      await what();
    } catch (error) {
      setTrouble((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  return html`<section class="sync">
    <h3>Sync</h3>
    ${() => (code() ? on(act, busy) : off(act, busy))}
    ${() => trouble() && html`<p class="note bad">${trouble}</p>`}
  </section>`;
}

/** Sync off: what it is, turning it on, and joining with a code. */
function off(act: (what: () => Promise<void>) => Promise<void>, busy: () => boolean) {
  const [typed, setTyped] = signal('');
  const submit = (e: Event) => {
    e.preventDefault();
    act(() => join(typed()));
  };
  const account = me()?.shelf;
  return html`${account
      ? html`<p class="hint">Your account's shelf is not synced on this device.</p>
          <button @click=${() => act(() => join(account))} .disabled=${busy}>
            Sync your account's shelf here
          </button>`
      : html`<p class="hint">
            Keep this shelf the same on your phone, tablet and computer. Turning sync on makes a
            code that is the shelf's key: anyone with it can see and change your books, so give it
            only to your own devices. No account needed.
          </p>
          <button @click=${() => act(enable)} .disabled=${busy}>Turn on sync</button>`}
    <form class="sync-join" @submit=${submit}>
      <input
        placeholder="I have a code"
        aria-label="Sync code"
        autocapitalize="characters"
        autocomplete="off"
        spellcheck="false"
        .value=${typed}
        @input=${(e: Event) => setTyped(valueOf(e))}
      />
      <button .disabled=${() => busy() || !typed().trim()}>Join</button>
    </form>`;
}

/** Sync on: how it goes, the code and its link, and stopping; signed in,
 * the code folded away, or a way to make it the account's. */
function on(act: (what: () => Promise<void>) => Promise<void>, busy: () => boolean) {
  const [copied, setCopied] = signal(false);
  const copy = async () => {
    await navigator.clipboard.writeText(link());
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };
  const share = () =>
    navigator.share({ title: 'cuento', text: 'Join my cuento shelf', url: link() }).catch(() => {});
  const stop = () =>
    confirm(
      'Stop syncing on this device? Its books stay here, and your other devices keep syncing.',
    ) && leave();
  const shelf = html`<p class="sync-code">${() => grouped(code())}</p>
    ${qr(link())}
    <div class="sync-actions">
      <button @click=${copy}>${() => (copied() ? 'Copied' : 'Copy link')}</button>
      ${'share' in navigator ? html`<button @click=${share}>Share</button>` : null}
    </div>`;
  const account = me()?.shelf;
  return html`<p class=${() => 'note sync-status' + (status() === 'syncing' ? ' looking' : '')}>
      ${() => SAID[status()]}
    </p>
    ${account === code()
      ? html`<details class="sync-share">
          <summary>Share this shelf</summary>
          ${shelf}
        </details>`
      : shelf}
    ${account && account !== code()
      ? html`<p class="hint">Your account keeps another shelf than this device syncs.</p>
          <button @click=${() => act(adopt)} .disabled=${busy}>
            Make this your account's shelf
          </button>`
      : null}
    <button class="sync-stop" @click=${stop}>Stop syncing on this device</button>`;
}

/** text as a QR code (an SVG, drawn once the encoder has loaded; nothing
 * if it can't load). */
function qr(text: string): Node {
  const box = document.createElement('div');
  box.className = 'sync-qr';
  box.setAttribute('role', 'img');
  box.setAttribute('aria-label', 'QR code of the sync link');
  import(QR).then(
    (m: QrModule) => {
      const q = m.default(0, 'M');
      q.addData(text);
      q.make();
      box.append(svg(q));
    },
    () => box.remove(),
  );
  return box;
}

/** q drawn as an SVG: a unit square per dark module, in one path. */
function svg(q: QrCode): SVGElement {
  const n = q.getModuleCount();
  let d = '';
  for (let row = 0; row < n; row++)
    for (let col = 0; col < n; col++) if (q.isDark(row, col)) d += `M${col} ${row}h1v1h-1z`;
  const ns = 'http://www.w3.org/2000/svg';
  const image = document.createElementNS(ns, 'svg');
  image.setAttribute('viewBox', `${-QUIET} ${-QUIET} ${n + 2 * QUIET} ${n + 2 * QUIET}`);
  image.setAttribute('shape-rendering', 'crispEdges');
  const path = document.createElementNS(ns, 'path');
  path.setAttribute('d', d);
  image.append(path);
  return image;
}
