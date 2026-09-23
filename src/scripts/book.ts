/**
 * The /book page's slot picker and booking form. Vanilla TypeScript, no
 * framework. The server is always the authority: every validation rule
 * mirrored here is for friendliness only, never enforced client-side alone.
 */

interface SlotsResponse {
  businessTimeZone: string;
  durationMinutes: number;
  slots: string[];
  generatedAt: string;
}

const app = document.getElementById('booking-app');
if (app) {
  const slotsUrl = app.dataset.slotsUrl!;
  const holdUrl = app.dataset.holdUrl!;

  const loadingEl = document.getElementById('booking-loading')!;
  const statusEl = document.getElementById('booking-status')!;
  const pickerEl = document.getElementById('slot-picker')!;
  const daysEl = document.getElementById('slot-days')!;
  const weekPrevBtn = document.getElementById('week-prev') as HTMLButtonElement;
  const weekNextBtn = document.getElementById('week-next') as HTMLButtonElement;
  const tzToggleBtn = document.getElementById('tz-toggle') as HTMLButtonElement;
  const tzLabelEl = document.getElementById('tz-label')!;
  const formEl = document.getElementById('booking-form') as HTMLFormElement;
  const selectedSlotEl = document.getElementById('selected-slot')!;
  const submitBtn = document.getElementById('booking-submit') as HTMLButtonElement;
  const formStatusEl = document.getElementById('form-status')!;
  const noteEl = document.getElementById('note') as HTMLTextAreaElement;
  const noteCountEl = document.getElementById('note-count')!;
  const nameEl = document.getElementById('name') as HTMLInputElement;
  const nameErrorEl = document.getElementById('name-error')!;
  const emailEl = document.getElementById('email') as HTMLInputElement;
  const emailErrorEl = document.getElementById('email-error')!;
  const confirmationEl = document.getElementById('booking-confirmation')!;
  const confirmationHeadingEl = document.getElementById('booking-confirmation-heading')!;

  app.classList.remove('hidden');

  const visitorTz = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Europe/London';
  let displayTz = visitorTz;
  let allSlots: string[] = [];
  let selectedSlot: string | null = null;
  let currentWeekIndex = 0;
  let weeks: string[][] = []; // each entry: 7 date keys (YYYY-MM-DD in displayTz), Monday first

  function showStatus(message: string, tone: 'info' | 'error' = 'info') {
    statusEl.textContent = message;
    statusEl.classList.remove('hidden', 'border-navy-300', 'border-maroon-500', 'text-navy-900', 'text-maroon-700', 'bg-white', 'bg-maroon-50');
    statusEl.classList.add(
      tone === 'error' ? 'border-maroon-500' : 'border-navy-300',
      tone === 'error' ? 'text-maroon-700' : 'text-navy-900',
      tone === 'error' ? 'bg-maroon-50' : 'bg-white',
    );
  }

  function hideStatus() {
    statusEl.classList.add('hidden');
  }

  function dateKey(iso: string, tz: string): string {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(
      new Date(iso),
    );
    const map: Record<string, string> = {};
    for (const p of parts) if (p.type !== 'literal') map[p.type] = p.value;
    return `${map.year}-${map.month}-${map.day}`;
  }

  function timeLabel(iso: string, tz: string): string {
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: 'numeric', minute: '2-digit', hour12: true }).format(new Date(iso));
  }

  function dayLabel(dateKeyStr: string, tz: string): string {
    // dateKeyStr is a plain YYYY-MM-DD; format it via a UTC-noon anchor so the
    // formatter's own timezone conversion can't push it onto the wrong day.
    const [y, m, d] = dateKeyStr.split('-').map(Number);
    const anchor = new Date(Date.UTC(y, m - 1, d, 12, 0, 0));
    return new Intl.DateTimeFormat('en-GB', { timeZone: tz, weekday: 'short', day: 'numeric', month: 'short' }).format(anchor);
  }

  function mondayOf(dateKeyStr: string): string {
    const [y, m, d] = dateKeyStr.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d));
    const weekday = date.getUTCDay(); // 0=Sun..6=Sat
    const diffToMonday = weekday === 0 ? -6 : 1 - weekday;
    date.setUTCDate(date.getUTCDate() + diffToMonday);
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  function addDaysToKey(dateKeyStr: string, days: number): string {
    const [y, m, d] = dateKeyStr.split('-').map(Number);
    const date = new Date(Date.UTC(y, m - 1, d + days));
    return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
  }

  function computeWeeks() {
    const daySet = new Set(allSlots.map((iso) => dateKey(iso, displayTz)));
    const mondays = Array.from(new Set(Array.from(daySet).map(mondayOf))).sort();
    weeks = mondays.map((monday) => Array.from({ length: 7 }, (_, i) => addDaysToKey(monday, i)));
    currentWeekIndex = Math.min(currentWeekIndex, Math.max(weeks.length - 1, 0));
  }

  function renderTzLabel() {
    const zoneLabel = displayTz === 'Europe/London' ? 'UK time' : 'your time zone';
    tzLabelEl.textContent = `Times shown in ${zoneLabel} (${displayTz})`;
    tzToggleBtn.textContent = displayTz === 'Europe/London' ? 'Show your local time' : 'Show UK time';
  }

  function renderWeek() {
    daysEl.innerHTML = '';
    if (weeks.length === 0) {
      showStatus('There are no bookable times in the next three weeks. Please email hello@cyphral.co.uk and I will find a time.');
      pickerEl.classList.add('hidden');
      return;
    }

    hideStatus();
    pickerEl.classList.remove('hidden');
    const week = weeks[currentWeekIndex];
    weekPrevBtn.disabled = currentWeekIndex === 0;
    weekNextBtn.disabled = currentWeekIndex === weeks.length - 1;

    const byDay = new Map<string, string[]>();
    for (const iso of allSlots) {
      const key = dateKey(iso, displayTz);
      if (!byDay.has(key)) byDay.set(key, []);
      byDay.get(key)!.push(iso);
    }

    for (const day of week) {
      const section = document.createElement('section');
      section.className = 'space-y-2';
      const heading = document.createElement('h2');
      heading.className = 'text-sm font-semibold text-navy-900';
      heading.textContent = dayLabel(day, displayTz);
      section.appendChild(heading);

      const daySlots = (byDay.get(day) ?? []).sort();
      if (daySlots.length === 0) {
        const none = document.createElement('p');
        none.className = 'text-sm text-neutral-500';
        none.textContent = 'No times';
        section.appendChild(none);
      } else {
        const list = document.createElement('div');
        list.className = 'flex flex-col gap-2';
        for (const iso of daySlots) {
          const button = document.createElement('button');
          button.type = 'button';
          button.className =
            'rounded-md border border-navy-300 px-3 py-2 text-sm font-medium text-navy-900 hover:bg-navy-50 focus:outline-none focus:ring-2 focus:ring-maroon-500/40 transition-colors aria-pressed:bg-navy-900 aria-pressed:text-white aria-pressed:border-navy-900';
          button.setAttribute('aria-pressed', String(iso === selectedSlot));
          button.textContent = timeLabel(iso, displayTz);
          button.addEventListener('click', () => selectSlot(iso));
          list.appendChild(button);
        }
        section.appendChild(list);
      }
      daysEl.appendChild(section);
    }
  }

  function selectSlot(iso: string) {
    selectedSlot = iso;
    renderWeek();
    selectedSlotEl.textContent = `Selected: ${dayLabel(dateKey(iso, displayTz), displayTz)} at ${timeLabel(iso, displayTz)} (${displayTz})`;
    formEl.classList.remove('hidden');
    const prefersReducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    formEl.scrollIntoView({ behavior: prefersReducedMotion ? 'auto' : 'smooth', block: 'nearest' });
    updateSubmitState();
  }

  function updateSubmitState() {
    const hasSlot = Boolean(selectedSlot);
    const hasName = nameEl.value.trim().length > 0;
    const hasEmail = emailEl.value.trim().length > 0;
    submitBtn.disabled = !(hasSlot && hasName && hasEmail && turnstileToken.length > 0);
  }

  weekPrevBtn.addEventListener('click', () => {
    if (currentWeekIndex > 0) {
      currentWeekIndex -= 1;
      renderWeek();
    }
  });
  weekNextBtn.addEventListener('click', () => {
    if (currentWeekIndex < weeks.length - 1) {
      currentWeekIndex += 1;
      renderWeek();
    }
  });
  tzToggleBtn.addEventListener('click', () => {
    displayTz = displayTz === 'Europe/London' ? visitorTz : 'Europe/London';
    renderTzLabel();
    renderWeek();
  });

  noteEl.addEventListener('input', () => {
    noteCountEl.textContent = `${noteEl.value.length} / 500`;
  });
  nameEl.addEventListener('input', updateSubmitState);
  emailEl.addEventListener('input', updateSubmitState);

  async function loadSlots() {
    try {
      const res = await fetch(slotsUrl);
      if (!res.ok) {
        loadingEl.classList.add('hidden');
        showStatus('Booking is paused right now. Email hello@cyphral.co.uk and I will find a time.', 'error');
        return;
      }
      const data = (await res.json()) as SlotsResponse;
      allSlots = data.slots;
      loadingEl.classList.add('hidden');
      renderTzLabel();
      computeWeeks();
      renderWeek();
    } catch {
      loadingEl.classList.add('hidden');
      showStatus('Booking is paused right now. Email hello@cyphral.co.uk and I will find a time.', 'error');
    }
  }

  // --- Turnstile ---
  let turnstileToken = '';
  let turnstileWidgetId: string | undefined;

  (window as unknown as { cyphralTurnstileSuccess: (token: string, ...rest: unknown[]) => void }).cyphralTurnstileSuccess = (
    token: string,
  ) => {
    turnstileToken = token;
    updateSubmitState();
  };
  (window as unknown as { cyphralTurnstileError: () => void }).cyphralTurnstileError = () => {
    turnstileToken = '';
    updateSubmitState();
  };
  (window as unknown as { cyphralTurnstileExpired: () => void }).cyphralTurnstileExpired = () => {
    turnstileToken = '';
    updateSubmitState();
  };

  function resetTurnstile() {
    turnstileToken = '';
    const turnstile = (window as unknown as { turnstile?: { reset: (id?: string) => void } }).turnstile;
    if (turnstile) turnstile.reset(turnstileWidgetId);
  }

  // --- Form submission ---
  function showFieldError(el: HTMLElement, message: string) {
    el.textContent = message;
    el.classList.remove('hidden');
  }
  function clearFieldErrors() {
    nameErrorEl.classList.add('hidden');
    emailErrorEl.classList.add('hidden');
  }

  formEl.addEventListener('submit', async (event) => {
    event.preventDefault();
    if (!selectedSlot) return;
    clearFieldErrors();

    const formData = new FormData(formEl);
    const payload = {
      slotStart: selectedSlot,
      name: String(formData.get('name') ?? ''),
      email: String(formData.get('email') ?? ''),
      company: String(formData.get('company') ?? ''),
      topic: String(formData.get('topic') ?? ''),
      note: String(formData.get('note') ?? ''),
      visitorTz,
      website: String(formData.get('website') ?? ''),
      turnstileToken,
    };

    submitBtn.disabled = true;
    formStatusEl.classList.add('hidden');
    let submitted = false;

    try {
      const res = await fetch(holdUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      if (res.status === 202) {
        formEl.reset();
        selectedSlot = null;
        pickerEl.classList.add('hidden');
        formEl.classList.add('hidden');
        confirmationEl.classList.remove('hidden');
        // Move focus to the panel rather than relying on aria-live alone, so
        // keyboard users (not just screen-reader users) land somewhere
        // sensible instead of focus reverting to <body> when the form with
        // the just-focused submit button gets hidden.
        confirmationHeadingEl.focus();
        submitted = true;
        return;
      }

      const body = (await res.json().catch(() => ({}))) as { error?: string; fields?: string[] };

      if (res.status === 409) {
        formStatusEl.textContent = 'That time was just taken. Please pick another below. Your other details are still filled in.';
        formStatusEl.classList.remove('hidden');
        selectedSlot = null;
        selectedSlotEl.textContent = '';
        updateSubmitState(); // no slot selected now, so this disables submit until a new one is picked
        await loadSlots();
      } else if (res.status === 429) {
        formStatusEl.textContent = 'Too many attempts. Please try again shortly.';
        formStatusEl.classList.remove('hidden');
      } else if (res.status === 403) {
        formStatusEl.textContent = 'The verification check failed. Please try again.';
        formStatusEl.classList.remove('hidden');
      } else if (res.status === 400 && body.fields) {
        if (body.fields.includes('name')) showFieldError(nameErrorEl, 'Please check your name.');
        if (body.fields.includes('email')) showFieldError(emailErrorEl, 'Please check your email address.');
        formStatusEl.textContent = 'Please check the highlighted fields.';
        formStatusEl.classList.remove('hidden');
      } else {
        formStatusEl.textContent = 'Booking is paused right now. Email hello@cyphral.co.uk and I will find a time.';
        formStatusEl.classList.remove('hidden');
      }
    } catch {
      formStatusEl.textContent = 'Sorry, something went wrong. Please email hello@cyphral.co.uk directly.';
      formStatusEl.classList.remove('hidden');
    } finally {
      resetTurnstile();
      if (!submitted) {
        submitBtn.disabled = false;
        updateSubmitState();
      }
    }
  });

  loadSlots();
}

export {}; // makes this a module, isolating its scope from the other page scripts
