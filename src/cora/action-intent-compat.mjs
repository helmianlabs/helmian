// Closed compatibility map between Cora's typed action classes and Helmian's
// local orchestration intent labels. This is descriptive only: it authorizes
// nothing and never invokes a provider.
const COMPATIBILITY = Object.freeze({
  search: Object.freeze({ coraAction: 'search', helmionIntent: 'read_search' }),
  draft: Object.freeze({ coraAction: 'draft', helmionIntent: 'draft' }),
  notify: Object.freeze({ coraAction: 'notify', helmionIntent: 'notify' }),
  'approval-required-execute': Object.freeze({ coraAction: 'approval-required-execute', helmionIntent: 'execute' }),
});

export function getCoraHelmionIntentCompatibility(coraAction) {
  const value = COMPATIBILITY[coraAction];
  return value ? Object.freeze({ ...value }) : null;
}

