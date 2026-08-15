const checkoutButton = document.querySelector('[data-guard-checkout]');
const checkoutStatus = document.querySelector('[data-guard-checkout-status]');

if (checkoutButton && checkoutStatus) {
  checkoutButton.addEventListener('click', async () => {
    checkoutButton.disabled = true;
    checkoutStatus.textContent = 'Checking checkout availability…';
    try {
      const response = await fetch('/api/billing/checkout', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ product: window.HELMION_SITE_CONFIG?.billing?.product ?? 'helmion-guard' }),
      });
      const body = await response.json();
      if (!response.ok || !body.checkoutUrl) throw new Error(body.code || 'checkout_unavailable');
      window.location.assign(body.checkoutUrl);
    } catch (error) {
      checkoutStatus.textContent = 'Checkout is not configured yet. No payment was started.';
      checkoutButton.disabled = false;
      console.info('[Helmian] checkout handoff unavailable:', error.message);
    }
  });
}
