/* A book's ownership and reading history, to edit: when it was acquired,
 * and every time through it, oldest first, each with its start and finish
 * (a blank finish: underway), removable; and a read done before cuento,
 * added by hand.
 *
 *   Acquired [date]
 *   Read 1      Started [date]  Finished [date]   Remove
 *   Reading now Started [date]  Finished [    ]   Remove
 *   + Add a past read ──► Started [date]  Finished [date]  Add read
 *
 * Opened wherever a book is: the shelf's details, and Your library. The
 * rules (one read underway at most, the status following the history)
 * are shelf.ts's; this shows them, and says why an edit was refused.
 * Depends on spark and shelf.ts. Leaves out the status switch, Added,
 * rating and notes, which are the caller's. */
import { signal, html } from './spark/index.js';
import type { Getter } from './spark/index.js';
import { isDate, withSessionDate, withPastRead, withoutSession } from './shelf.ts';
import type { Book, Reading } from './shelf.ts';

/** The text of the field an event came from. */
const valueOf = (e: Event) => (e.target as HTMLInputElement).value;

/** The editor for book's acquisition date and reading history. change
 * applies an edit to the book as it then is (the caller saves it). */
export function historyEditor(book: Getter<Book>, change: (edit: (b: Book) => Book) => void) {
  const [trouble, setTrouble] = signal('');
  const [adding, setAdding] = signal(false);
  /** Makes edit when it may be made, or says why not and puts input back. */
  const attempt = (edit: (b: Book) => Book | string, input?: HTMLInputElement, was = '') => {
    const tried = edit(book());
    if (typeof tried === 'string') {
      setTrouble(tried);
      if (input) input.value = was;
      return false;
    }
    setTrouble('');
    change(b => {
      const done = edit(b);
      return typeof done === 'string' ? b : done;
    });
    return true;
  };

  const session = (r: Reading, i: number, n: number) => {
    const which = r.finished ? 'Read ' + n : 'Reading now';
    const date = (key: keyof Reading, label: string) =>
      html`<label
        >${label}
        <input
          type="date"
          max="9999-12-31"
          .value=${r[key]}
          @change=${(e: Event) =>
            attempt(
              b => withSessionDate(b, i, key, valueOf(e)),
              e.target as HTMLInputElement,
              r[key],
            )}
      /></label>`;
    const remove = () => {
      if (confirm('Remove ' + (r.finished ? 'read ' + n : 'this read') + ' from the history?'))
        attempt(b => withoutSession(b, i));
    };
    return html`<li class="session">
      <span class="which">${which}</span>
      <div class="dates">${date('started', 'Started')} ${date('finished', 'Finished')}</div>
      <button type="button" class="forget" aria-label=${'Remove ' + which} @click=${remove}>
        Remove
      </button>
    </li>`;
  };

  const past = () => {
    const [started, setStarted] = signal('');
    const [finished, setFinished] = signal('');
    const add = (e: Event) => {
      e.preventDefault();
      if (attempt(b => withPastRead(b, started(), finished()))) setAdding(false);
    };
    return html`<form class="past" @submit=${add}>
      <div class="dates">
        <label
          >Started
          <input
            type="date"
            max="9999-12-31"
            .value=${started}
            @change=${(e: Event) => setStarted(valueOf(e))}
        /></label>
        <label
          >Finished
          <input
            type="date"
            max="9999-12-31"
            .value=${finished}
            @change=${(e: Event) => setFinished(valueOf(e))}
        /></label>
      </div>
      <div class="past-actions">
        <button>Add read</button>
        <button type="button" class="quiet" @click=${() => setAdding(false)}>Cancel</button>
      </div>
    </form>`;
  };

  return html`<section class="history" aria-label="Ownership and reading history">
    <div class="dates">
      <label
        >Acquired
        <input
          type="date"
          max="9999-12-31"
          .value=${() => book().acquired}
          max="9999-12-31"
          @change=${(e: Event) => {
            if (isDate(valueOf(e))) change(b => ({ ...b, acquired: valueOf(e) }));
            else (e.target as HTMLInputElement).value = book().acquired;
          }}
      /></label>
    </div>
    <h3>Reading history</h3>
    ${() => {
      let n = 0;
      const readings = book().readings;
      return readings.length
        ? html`<ol class="sessions">
            ${readings.map((r, i) => session(r, i, r.finished ? ++n : n))}
          </ol>`
        : html`<p class="hint">Not read yet.</p>`;
    }}
    ${() => (trouble() ? html`<p class="note bad" role="status">${trouble()}</p>` : null)}
    ${() =>
      adding()
        ? past()
        : html`<button
            type="button"
            class="add-past"
            @click=${() => {
              setTrouble('');
              setAdding(true);
            }}
          >
            + Add a past read
          </button>`}
  </section>`;
}
