/**
 * /book/cancel — same token-in-fragment, click-to-act pattern as
 * /book/confirm. See that file's header comment for why.
 */

const statusEl = document.getElementById('cancel-status')!;
const actionEl = document.getElementById('cancel-action')!;
const cancelBtn = document.getElementById('cancel-button') as HTMLButtonElement;

const token = new URLSearchParams(window.location.hash.replace(/^#/, '')).get('t');
history.replaceState(null, '', window.location.pathname + window.location.search);

function showStatus(html: string) {
  statusEl.innerHTML = html;
}

if (!token) {
  actionEl.classList.add('hidden');
  showStatus(
    'This link is missing its cancellation code. <a href="/book" class="text-maroon-700 underline underline-offset-4">Book a new time</a>.',
  );
} else {
  cancelBtn.addEventListener('click', async () => {
    cancelBtn.disabled = true;
    try {
      const res = await fetch('/api/booking/cancel', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ token }),
      });

      actionEl.classList.add('hidden');
      if (res.ok) {
        showStatus('Your call has been cancelled. You can book another time whenever suits.');
        return;
      }

      showStatus(
        'This link has expired, already been used, or the call has already started. <a href="/book" class="text-maroon-700 underline underline-offset-4">Book a new time</a>.',
      );
    } catch {
      cancelBtn.disabled = false;
      showStatus('Sorry, something went wrong. Please try again, or email hello@cyphral.co.uk.');
    }
  });
}

export {}; // makes this a module, isolating its scope from the other page scripts
