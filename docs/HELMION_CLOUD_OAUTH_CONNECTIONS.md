# Helmian Cloud provider connections

Desktop subscription artifacts never move into Helmian Cloud. Each tenant must
approve a separate cloud provider connection. The current contract records only
tenant-admin intent, PKCE state, scopes, and a secure callback URL. It rejects
tokens, secrets, and code verifiers. A future callback needs a provider-approved
app registration, documented endpoints/scopes, and encrypted token storage with
rotation, revocation, and tenant-scoped audit. Until then, no live call occurs.
