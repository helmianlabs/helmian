const checkoutButtons = document.querySelectorAll('[data-guard-checkout]');
const checkoutStatus = document.querySelector('[data-guard-checkout-status]');

if (checkoutButtons.length && checkoutStatus) {
  checkoutButtons.forEach((checkoutButton) => checkoutButton.addEventListener('click', async () => {
    checkoutButtons.forEach((button) => { button.disabled = true; });
    checkoutStatus.textContent = 'Checking checkout availability…';
    try {
      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ product: checkoutButton.dataset.product || window.HELMION_SITE_CONFIG?.billing?.products?.guard || 'helmian_guard' }),
      });
      const body = await response.json();
      if (!response.ok || !body.checkoutUrl) throw new Error(body.code || 'checkout_unavailable');
      window.location.assign(body.checkoutUrl);
    } catch (error) {
      checkoutStatus.textContent = 'Checkout is not configured yet. No payment was started.';
      checkoutButtons.forEach((button) => { button.disabled = false; });
      console.info('[Helmian] checkout handoff unavailable:', error.message);
    }
  }));
}
