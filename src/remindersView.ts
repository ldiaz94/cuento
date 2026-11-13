/* Reminders' part of the Settings sheet: a nudge to read at a time and
 * on days of one's choosing, and word when the Year in review is ready.
 *
 *   [ ] Remind me to read ── At [21:00] ── Mon Tue Wed Thu Fri Sat Sun
 *   [ ] Tell me when my Year in review is ready ── Send a test
 *
 * Off until a switch is tapped, which is when the browser asks for
 * permission. Where this device can't have reminders, or has blocked
 * them, it says why and what to do instead. Depends on spark and
 * reminders.ts. Leaves out more than one reminder a day. */
import { signal, html } from './spark/index.js';
import { prefs, standing, wanted, change, refresh, test } from './reminders.ts';
import type { Prefs } from './reminders.ts';

/** The days as the chips show them, Monday first: label, then the day's
 * number (0: Sunday). */
const DAYS: [string, number][] = [
  ['Mon', 1],
  ['Tue', 2],
  ['Wed', 3],
  ['Thu', 4],
  ['Fri', 5],
  ['Sat', 6],
  ['Sun', 0],
];

/** What the section says when reminders can't be had, or are blocked. */
const CANNOT = {
  install:
    'On iPhone and iPad, reminders work once cuento is on your Home Screen: in Safari, tap Share, then Add to Home Screen, and open cuento from there.',
  unsupported: 'This browser can’t show notifications from cuento. Try another, or install cuento.',
  denied:
    'Notifications are blocked for cuento. To allow them: on iPhone or iPad, open Settings › Notifications › cuento; in Chrome, tap the icon beside the address › Permissions › Notifications. Then come back here.',
};

/** The Reminders section of Settings. */
export function remindersSection(): Node {
  const [trouble, setTrouble] = signal('');
  const [said, setSaid] = signal('');
  const [busy, setBusy] = signal(false);
  /** Runs what a control does, showing what went wrong, if anything. */
  const act = async (what: () => Promise<void>) => {
    setBusy(true);
    setTrouble('');
    setSaid('');
    try {
      await what();
    } catch (error) {
      setTrouble((error as Error).message);
    } finally {
      setBusy(false);
    }
  };
  act(refresh);

  /** A switch for one of the prefs; put back if the change was refused. */
  const toggle = (field: 'enabled' | 'review', label: string) => {
    const flip = (e: Event) => {
      const box = e.target as HTMLInputElement;
      act(() => change({ ...prefs(), [field]: box.checked })).then(() => {
        box.checked = prefs()[field];
      });
    };
    return html`<label class="switch">
      <input
        type="checkbox"
        role="switch"
        .checked=${() => prefs()[field]}
        .disabled=${busy}
        @change=${flip}
      />
      ${label}
    </label>`;
  };
  /** Changes some of the prefs. */
  const set = (some: Partial<Prefs>) => act(() => change({ ...prefs(), ...some }));
  /** Picks a day or drops it (the last day stays). */
  const day = (n: number) => {
    const days = prefs().days;
    if (!days.includes(n)) set({ days: [...days, n] });
    else if (days.length > 1) set({ days: days.filter(d => d !== n) });
  };
  const when = () =>
    prefs().enabled &&
    html`<div class="reminder-when">
      <label class="reminder-time"
        >At
        <input
          type="time"
          required
          .value=${() => prefs().time}
          .disabled=${busy}
          @change=${(e: Event) => {
            const time = (e.target as HTMLInputElement).value;
            if (time) set({ time });
          }}
      /></label>
      <div class="reminder-days" role="group" aria-label="Days">
        ${DAYS.map(
          ([label, n]) =>
            html`<button
              type="button"
              class=${() => 'chip' + (prefs().days.includes(n) ? ' on' : '')}
              aria-pressed=${() => String(prefs().days.includes(n))}
              .disabled=${busy}
              @click=${() => day(n)}
            >
              ${label}
            </button>`,
        )}
      </div>
    </div>`;
  const sendTest = () =>
    act(async () => {
      await test();
      setSaid('Sent: it should arrive in a moment.');
    });

  const controls = () => {
    const s = standing();
    if (s === 'install' || s === 'unsupported') return html`<p class="hint">${CANNOT[s]}</p>`;
    return html`<p class="hint">
        A gentle nudge to read, at a time you choose. Nothing about your books leaves this device.
      </p>
      ${toggle('enabled', 'Remind me to read')} ${when}
      ${toggle('review', 'Tell me when my Year in review is ready')}
      ${() =>
        s === 'denied'
          ? html`<p class="note bad">${CANNOT.denied}</p>`
          : wanted(prefs()) &&
            s === 'granted' &&
            html`<button @click=${sendTest} .disabled=${busy}>Send a test</button>`}`;
  };
  return html`<section class="reminders">
    <h3>Reminders</h3>
    ${controls} ${() => said() && html`<p class="note">${said}</p>`}
    ${() => trouble() && html`<p class="note bad">${trouble}</p>`}
  </section>`;
}
