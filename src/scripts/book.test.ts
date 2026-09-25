/**
 * DOM-level tests for the /book page's client script — see book.astro's
 * matching fixture markup below. Each test re-imports the module fresh
 * against a newly-built DOM (vi.resetModules() + a fresh dynamic import),
 * the same way a real browser re-runs a page script on every real page
 * load, so tests don't leak state into each other via cached module scope.
 *
 * window.turnstile is always a stub here — the real Cloudflare widget
 * script is never loaded in tests. Each test's stub calls the page's own
 * cyphralTurnstileSuccess/Error/Expired globals exactly the way the real
 * widget would after execute() resolves, so what's actually under test is
 * book.ts's own coordination logic, not Cloudflare's.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const FUTURE_SLOT_ISO = '2099-01-05T10:00:00Z';

const FIXTURE_HTML = `
  <div id="booking-app" class="hidden" data-slots-url="/api/booking/slots" data-book-url="/api/booking/book">
    <div id="booking-loading" aria-hidden="true"></div>
    <p id="booking-status" class="hidden" role="status" aria-live="polite"></p>
    <div id="slot-picker" class="hidden">
      <button type="button" id="week-prev">Previous week</button>
      <button type="button" id="week-next">Next week</button>
      <button type="button" id="tz-toggle">Show UK time</button>
      <p id="tz-label"></p>
      <div id="slot-days"></div>
    </div>
    <form id="booking-form" class="hidden" novalidate>
      <p id="selected-slot"></p>
      <div>
        <input type="text" id="name" name="name" required autocomplete="name" maxlength="80" aria-describedby="name-error" />
        <p id="name-error" class="hidden"></p>
      </div>
      <div>
        <input type="email" id="email" name="email" required autocomplete="email" maxlength="254" aria-describedby="email-error" />
        <p id="email-error" class="hidden"></p>
      </div>
      <div>
        <input type="text" id="company" name="company" autocomplete="organization" maxlength="120" />
      </div>
      <div>
        <select id="topic" name="topic" required>
          <option value="ce-readiness">Getting Cyber Essentials for the first time</option>
          <option value="not-sure">Not sure yet</option>
        </select>
      </div>
      <div>
        <textarea id="note" name="note" rows="4" maxlength="500" aria-describedby="note-count"></textarea>
        <p id="note-count">0 / 500</p>
      </div>
      <div aria-hidden="true">
        <input type="text" id="website" name="website" tabindex="-1" autocomplete="off" />
      </div>
      <div id="cf-turnstile-widget" class="cf-turnstile min-h-[65px]" data-sitekey="test-sitekey" data-action="booking_book" data-execution="execute" data-appearance="interaction-only" data-callback="cyphralTurnstileSuccess" data-error-callback="cyphralTurnstileError" data-expired-callback="cyphralTurnstileExpired"></div>
      <div>
        <button type="submit" id="booking-submit">Request this time</button>
      </div>
      <p id="form-status" class="hidden" role="status" aria-live="polite"></p>
    </form>
    <div id="booking-confirmation" class="hidden">
      <h2 id="booking-confirmation-heading" tabindex="-1">You're booked</h2>
    </div>
  </div>
`;

interface TurnstileStub {
  execute: ReturnType<typeof vi.fn>;
  reset: ReturnType<typeof vi.fn>;
}

/**
 * Default: execute() succeeds immediately with a fresh-looking token — the
 * common non-interactive-pass case, where appearance "interaction-only"
 * never shows anything. `manual: true` simulates a visible challenge the
 * visitor has to actually complete: execute() does nothing on its own, and
 * the test resolves it later by calling the same global callback the real
 * widget would. `onExecute` fully replaces the default for error/expired
 * cases.
 */
function installTurnstileStub(options?: { manual?: boolean; onExecute?: () => void }): TurnstileStub {
  let tokenCounter = 0;
  const execute = vi.fn(() => {
    if (options?.onExecute) {
      options.onExecute();
      return;
    }
    if (options?.manual) return; // the test itself decides when/how this resolves
    tokenCounter += 1;
    (window as unknown as { cyphralTurnstileSuccess: (token: string) => void }).cyphralTurnstileSuccess(`fresh-token-${tokenCounter}`);
  });
  const reset = vi.fn();
  (window as unknown as { turnstile: TurnstileStub }).turnstile = { execute, reset };
  return { execute, reset };
}

function slotsResponse(): Response {
  return new Response(
    JSON.stringify({
      businessTimeZone: 'Europe/London',
      durationMinutes: 30,
      slots: [FUTURE_SLOT_ISO],
      generatedAt: new Date().toISOString(),
    }),
    { status: 200, headers: { 'Content-Type': 'application/json' } },
  );
}

function flushPromises(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

/** Loads the module fresh, waits for loadSlots() to finish, and returns the key elements tests interact with. */
async function boot() {
  document.body.innerHTML = FIXTURE_HTML;
  vi.resetModules();
  await import('./book.ts');
  await flushPromises(); // let loadSlots()'s fetch/json/render chain settle

  return {
    formEl: document.getElementById('booking-form') as HTMLFormElement,
    submitBtn: document.getElementById('booking-submit') as HTMLButtonElement,
    nameEl: document.getElementById('name') as HTMLInputElement,
    emailEl: document.getElementById('email') as HTMLInputElement,
    nameErrorEl: document.getElementById('name-error')!,
    emailErrorEl: document.getElementById('email-error')!,
    formStatusEl: document.getElementById('form-status')!,
    confirmationEl: document.getElementById('booking-confirmation')!,
  };
}

function selectFirstSlot() {
  const slotButton = document.querySelector<HTMLButtonElement>('#slot-days button');
  if (!slotButton) throw new Error('no slot button rendered — fixture/mock mismatch');
  slotButton.click();
}

function fillValidFields(els: { nameEl: HTMLInputElement; emailEl: HTMLInputElement }) {
  els.nameEl.value = 'Ada Lovelace';
  els.emailEl.value = 'ada@example.com';
}

function submit(formEl: HTMLFormElement) {
  formEl.dispatchEvent(new Event('submit', { cancelable: true, bubbles: true }));
}

let fetchMock: ReturnType<typeof vi.fn>;
let postHandler: (init: RequestInit) => Response | Promise<Response>;

beforeEach(() => {
  postHandler = () => new Response(JSON.stringify({ status: 'booked' }), { status: 201 });
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (!init || !init.method || init.method === 'GET') return slotsResponse();
    return postHandler(init);
  });
  vi.stubGlobal('fetch', fetchMock);

  // Not implemented by happy-dom; selectSlot() calls both unconditionally.
  Element.prototype.scrollIntoView = vi.fn();
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe('submit button — never gated on form state, only on a request actually being in flight', () => {
  it('is not disabled by browser-restored field values with no input events fired (the original bug)', async () => {
    installTurnstileStub();
    const { formEl, submitBtn, nameEl, emailEl } = await boot();

    selectFirstSlot();
    // Simulate the browser restoring these directly (bfcache / reload
    // form-restore / autofill that skips synthetic events) — set .value
    // without ever dispatching 'input'.
    nameEl.value = 'Restored Name';
    emailEl.value = 'restored@example.com';

    expect(formEl.classList.contains('hidden')).toBe(false);
    expect(submitBtn.disabled).toBe(false); // never disabled by field state to begin with
  });

  it('a fresh page load with no interaction at all leaves the button enabled (it is simply unreachable until a slot is shown)', async () => {
    installTurnstileStub();
    const { submitBtn } = await boot();
    expect(submitBtn.disabled).toBe(false);
  });
});

describe('field validation happens at click time', () => {
  it('missing name and email: inline errors shown, no request sent, button still clickable', async () => {
    installTurnstileStub();
    const { formEl, submitBtn, nameErrorEl, emailErrorEl, formStatusEl } = await boot();

    selectFirstSlot();
    // Deliberately leave name/email empty.
    submit(formEl);
    await flushPromises();

    expect(nameErrorEl.classList.contains('hidden')).toBe(false);
    expect(emailErrorEl.classList.contains('hidden')).toBe(false);
    expect(formStatusEl.classList.contains('hidden')).toBe(false);
    expect(submitBtn.disabled).toBe(false); // validation failed before the button was ever touched
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the initial GET for slots — no POST
  });
});

describe('failed requests re-enable the button and reset the widget', () => {
  it('a 403 (expired check) shows expiry copy, not failure copy, and re-enables the button', async () => {
    const stub = installTurnstileStub();
    postHandler = () => new Response(JSON.stringify({ error: 'challenge_failed' }), { status: 403 });
    const { formEl, submitBtn, nameEl, emailEl, formStatusEl } = await boot();

    selectFirstSlot();
    fillValidFields({ nameEl, emailEl });
    submit(formEl);
    await flushPromises();

    expect(formStatusEl.textContent).toContain('expired');
    expect(formStatusEl.textContent).not.toMatch(/failed/i);
    expect(submitBtn.disabled).toBe(false);
    expect(stub.reset).toHaveBeenCalled(); // widget reset after the failure, so a retry gets a new token
  });

  it('a retry after a failed request succeeds and uses a newly executed token', async () => {
    const stub = installTurnstileStub();
    let calls = 0;
    postHandler = () => {
      calls += 1;
      if (calls === 1) return new Response(JSON.stringify({ error: 'challenge_failed' }), { status: 403 });
      return new Response(JSON.stringify({ status: 'booked' }), { status: 201 });
    };
    const { formEl, submitBtn, nameEl, emailEl, confirmationEl } = await boot();

    selectFirstSlot();
    fillValidFields({ nameEl, emailEl });
    submit(formEl);
    await flushPromises();
    expect(submitBtn.disabled).toBe(false);

    submit(formEl);
    await flushPromises();

    expect(stub.execute).toHaveBeenCalledTimes(2); // fresh execute() on each attempt, never reused
    expect(confirmationEl.classList.contains('hidden')).toBe(false); // second attempt succeeded
  });

  it('a network error also re-enables the button', async () => {
    installTurnstileStub();
    postHandler = () => {
      throw new Error('network down');
    };
    const { formEl, submitBtn, nameEl, emailEl, formStatusEl } = await boot();

    selectFirstSlot();
    fillValidFields({ nameEl, emailEl });
    submit(formEl);
    await flushPromises();

    expect(formStatusEl.classList.contains('hidden')).toBe(false);
    expect(submitBtn.disabled).toBe(false);
  });

  it('an expired Turnstile check before the request is even sent still re-enables the button and resets the widget', async () => {
    const stub = installTurnstileStub({
      onExecute: () => {
        (window as unknown as { cyphralTurnstileExpired: () => void }).cyphralTurnstileExpired();
      },
    });
    const { formEl, submitBtn, nameEl, emailEl, formStatusEl } = await boot();

    selectFirstSlot();
    fillValidFields({ nameEl, emailEl });
    submit(formEl);
    await flushPromises();

    expect(formStatusEl.textContent).toContain('expired');
    expect(submitBtn.disabled).toBe(false);
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the GET for slots — never reached the POST at all
    expect(stub.reset).toHaveBeenCalledTimes(1); // getFreshTurnstileToken always resets before it executes, even on the first attempt
  });
});

describe('a visible challenge (appearance "interaction-only") does not require a second click', () => {
  it('shows "Checking..." while the challenge is unresolved, "Requesting..." once it resolves, and completes the booking from the same click', async () => {
    const stub = installTurnstileStub({ manual: true });
    let resolvePost!: (res: Response) => void;
    postHandler = () => new Promise<Response>((resolve) => { resolvePost = resolve; });
    const { formEl, submitBtn, nameEl, emailEl, confirmationEl } = await boot();

    selectFirstSlot();
    fillValidFields({ nameEl, emailEl });
    submit(formEl);
    await flushPromises();

    // The challenge hasn't resolved yet — nothing has been posted, and the
    // button says so rather than sitting there looking frozen.
    expect(submitBtn.disabled).toBe(true);
    expect(submitBtn.textContent).toBe('Checking...');
    expect(fetchMock).toHaveBeenCalledTimes(1); // only the earlier GET for slots

    // The visitor completes the (simulated) visible challenge.
    (window as unknown as { cyphralTurnstileSuccess: (token: string) => void }).cyphralTurnstileSuccess('completed-challenge-token');
    await flushPromises();

    // Proceeded automatically from the same original click — no second submit.
    expect(submitBtn.textContent).toBe('Requesting...');
    expect(stub.execute).toHaveBeenCalledTimes(1);
    const postCall = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
    expect(postCall).toBeDefined();
    const body = JSON.parse((postCall![1] as RequestInit).body as string);
    expect(body.turnstileToken).toBe('completed-challenge-token');

    resolvePost(new Response(JSON.stringify({ status: 'booked' }), { status: 201 }));
    await flushPromises();

    expect(confirmationEl.classList.contains('hidden')).toBe(false);
  });
});

describe('double submission', () => {
  it('two submit events fired back to back result in exactly one POST', async () => {
    installTurnstileStub();
    const { formEl, nameEl, emailEl } = await boot();

    selectFirstSlot();
    fillValidFields({ nameEl, emailEl });
    submit(formEl);
    submit(formEl); // fired before the first attempt's async work has yielded back to this synchronous caller
    await flushPromises();

    const postCalls = fetchMock.mock.calls.filter((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
    expect(postCalls).toHaveLength(1);
  });
});

describe('token freshness', () => {
  it('is fetched at click time, so submitting more than 5 minutes after load still works', async () => {
    vi.useFakeTimers();
    try {
      const stub = installTurnstileStub();
      document.body.innerHTML = FIXTURE_HTML;
      vi.resetModules();
      await import('./book.ts');
      await vi.advanceTimersByTimeAsync(0);

      selectFirstSlot();
      const nameEl = document.getElementById('name') as HTMLInputElement;
      const emailEl = document.getElementById('email') as HTMLInputElement;
      fillValidFields({ nameEl, emailEl });

      expect(stub.execute).not.toHaveBeenCalled(); // no token captured just from selecting a slot / filling the form

      vi.advanceTimersByTime(6 * 60 * 1000); // the page just sits open for 6 minutes

      const formEl = document.getElementById('booking-form') as HTMLFormElement;
      submit(formEl);
      await vi.advanceTimersByTimeAsync(0);

      expect(stub.execute).toHaveBeenCalledTimes(1); // only ever called at the moment of this click
      const postCall = fetchMock.mock.calls.find((call) => (call[1] as RequestInit | undefined)?.method === 'POST');
      const body = JSON.parse((postCall![1] as RequestInit).body as string);
      expect(body.turnstileToken).toBe('fresh-token-1');
    } finally {
      vi.useRealTimers();
    }
  });
});
