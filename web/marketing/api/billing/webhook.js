import { createEntitlementWebhookHandler } from './stripe-contract.js';
import { createRuntimeEntitlementStore } from './entitlement-store.js';

export default createEntitlementWebhookHandler({ entitlementStore: createRuntimeEntitlementStore() });
