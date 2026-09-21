/**
 * /book/confirm — reads the token from the URL fragment (never sent to the
 * server as part of a GET), clears the fragment, and only POSTs when the
 * visitor clicks the button. Loading this page must never, by itself,
 * confirm anything — an email scanner (Safe Links, Mimecast) that opens
 * the link automatically must not be able to act on the visitor's behalf.
 */

const statusEl = document.getElementById('confirm-status')!;
const actionEl = document.getElementById('confirm-action')!;
const confirmBtn = document.getElementById('confirm-button') as HTMLButtonElement;

const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('t');
history.replaceState(null, '', window.location.pathname + window.location.search);

function showStatus(html: string) {
  statusEl.innerHTML = html;
}

if (!token) {
  actionEl.classList.add('hidden');
  showStatus(
    'This link is missing its confirmation code. <a href="/book" class="text-maroon-700 underline underline-offset-4">Book a new time</a>.',
  );
} else {
  confirmBtn.addEventListener('click', async () => {
    confirmBtn.disabled = true;
    try {
      const res = await fetch('/api/booking/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      if (res.ok) {
        const body = (await res.json()) as { slotStart: string };
        actionEl.classList.add('hidden');
        showStatus(
          `Your call is confirmed (${new Date(body.slotStart).toLocaleString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', hour: 'numeric', minute: '2-digit' })}). A confirmation email is on its way.`,
        );
        return;
      }

      const errBody = (await res.json().catch(() => ({}))) as { error?: string };
      actionEl.classList.add('hidden');
      if (errBody.error === 'slot_unavailable') {
        showStatus(
          'That time is no longer available. <a href="/book" class="text-maroon-700 underline underline-offset-4">Book a new time</a>.',
        );
      } else {
        showStatus(
          'This link has expired or already been used. <a href="/book" class="text-maroon-700 underline underline-offset-4">Book a new time</a>.',
        );
      }
    } catch {
      confirmBtn.disabled = false;
      showStatus('Sorry, something went wrong. Please try again, or email hello@cyphral.co.uk.');
    }
  });
}

export {}; // makes this a module, isolating its scope from the other page scripts
