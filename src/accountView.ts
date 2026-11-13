/* The account's part of the Settings sheet: creating a passkey or signing
 * in with one, and, once signed in, the account's passkeys, adding one,
 * and signing out.
 *
 *   signed out:  what an account is ── Create a passkey ── Sign in
 *   signed in:   iPhone · added … · last used … [Remove] ── Add a passkey ── Sign out
 *
 * Asks the server who is signed in each time Settings opens. Depends on
 * spark and account.ts. Leaves out renaming a passkey. */
import { signal, html, each } from './spark/index.js';
import { me, refresh, signUp, signIn, addPasskey, removePasskey, signOut } from './account.ts';
import type { Passkey } from './account.ts';

/** A day, as the passkeys list shows it: 13 Nov 2026. */
const day = (ms: number) =>
  new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });

/** The Account section of Settings. */
export function accountSection(): Node {
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
  act(refresh);
  return html`<section class="account">
    <h3>Account</h3>
    ${() => (me() ? signedIn(act, busy) : signedOut(act, busy))}
    ${() => trouble() && html`<p class="note bad">${trouble}</p>`}
  </section>`;
}

/** What a button runs through: busy meanwhile, its trouble shown. */
type Act = (what: () => Promise<void>) => Promise<void>;

/** Signed out: what an account is, making one, and signing in. */
function signedOut(act: Act, busy: () => boolean) {
  return html`<p class="hint">
      Sign in with a passkey — your phone's Face ID, fingerprint or screen lock — and your shelf
      follows you to any device. No email, no password.
    </p>
    <div class="account-actions">
      <button @click=${() => act(signUp)} .disabled=${busy}>Create a passkey</button>
      <button @click=${() => act(signIn)} .disabled=${busy}>Sign in</button>
    </div>`;
}

/** Signed in: the passkeys, adding one, and signing out. */
function signedIn(act: Act, busy: () => boolean) {
  const passkeys = () => me()?.passkeys ?? [];
  const remove = (p: Passkey) =>
    confirm(`Remove the passkey "${p.name}"? It will no longer sign in to cuento.`) &&
    act(() => removePasskey(p.id));
  const out = () =>
    confirm('Sign out on this device? Its books stay here, and keep syncing.') && act(signOut);
  return html`<p class="note">Signed in: your shelf follows your passkey.</p>
    <ul class="passkeys">
      ${each(
        passkeys,
        p => p.id,
        p =>
          html`<li>
            <span class="passkey-name">${() => p().name}</span>
            <span class="passkey-dates"
              >added ${() => day(p().created)} · last used ${() => day(p().lastUsed)}</span
            >
            ${() =>
              passkeys().length > 1
                ? html`<button
                    class="passkey-remove"
                    aria-label=${'Remove passkey ' + p().name}
                    @click=${() => remove(p())}
                    .disabled=${busy}
                  >
                    Remove
                  </button>`
                : null}
          </li>`,
      )}
    </ul>
    <p class="hint">
      On another device, open cuento and tap Sign in: a passkey saved to your iCloud Keychain or
      Google Password Manager is already there. Or add one here, on this device or a phone nearby.
    </p>
    <button @click=${() => act(addPasskey)} .disabled=${busy}>Add a passkey</button>
    <button class="account-out" @click=${out} .disabled=${busy}>Sign out</button>`;
}
