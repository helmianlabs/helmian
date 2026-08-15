import { createEntitlementWebhookHandler } from './stripe-contract.js';
import { createEntitlementStore } from './entitlement-store.js';

export default createEntitlementWebhookHandler({ entitlementStore: createEntitlementStore() });
