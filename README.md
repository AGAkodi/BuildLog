# BuildLog

[Live application](https://buildlog.akodi-buildlog.workers.dev/) · [Privacy policy](https://buildlog.akodi-buildlog.workers.dev/privacy)

BuildLog helps builders turn public GitHub progress into a reviewable social update and queue it through Buffer. Sign in with GitHub, choose one of your public repositories or enter another public repository, select a recent commit or merged pull request, choose and edit a draft, and approve it for a connected Buffer channel.

Drafts are deterministic templates based on commit messages or PR titles. BuildLog links to the source and warns that a commit or merge does not prove a change is released or live. It does not analyze code diffs or independently verify claims. A queued post is not yet a published post.

## Requirements

- Node.js 22.13 or later for the local application and tests.
- A Cloudflare D1 database initialized with `cloudflare/schema.sql`.
- A GitHub OAuth app and a Buffer OAuth client. Each callback must match the URL configured in its provider.
- An encryption key shared consistently across restarts and deployments. Losing the key makes stored Buffer credentials unreadable.

## Local setup

Copy `.env.example` to `.env` and fill in the placeholders. Never commit real credentials. `APP_URL` must match the origin used to access the app; Buffer may require an HTTPS callback. For local D1 access, create a Cloudflare API token with D1 write access scoped to the intended account. The Worker deployment uses a direct D1 binding instead and does not need that token.

Generate an encryption key securely with:

```sh
node -e "console.log(require('crypto').randomBytes(32).toString('base64'))"
```

Store it in `BUFFER_TOKEN_ENCRYPTION_KEY` and back it up securely. Start the local Node server with:

```sh
node --env-file=.env server.js
```

On Windows, the optional `start-buildlog.ps1` helper was created for the original ngrok setup; review its configured address and database IDs before use. Git-ignored local `.env.*` and credential files must remain private.

## Test and build

```sh
npm test
npm run build:assets
```

The tests use Node's `node:sqlite` module, a temporary in-memory SQLite database, and mocked GitHub and Buffer responses. They do not replace a live OAuth and queue verification. Run `build:assets` after changing files in `public/`; the Worker imports the generated `cloudflare/assets.js` module.

## Cloudflare deployment

`worker.js` runs with `nodejs_compat` and a D1 binding named `DB`. Set `APP_URL`, `GITHUB_CLIENT_ID`, `GITHUB_CLIENT_SECRET`, `BUFFER_CLIENT_ID`, `BUFFER_CLIENT_SECRET`, and `BUFFER_TOKEN_ENCRYPTION_KEY` as Worker bindings; store all credentials and the encryption key as secrets. The OAuth callback paths are `/api/auth/github/callback` and `/api/buffer/callback` on the public origin. The optional `GITHUB_TOKEN` is used only for public GitHub API rate limits.

The public Worker uses durable, per-user queue submission keys. A request with an uncertain outcome remains blocked for that key: check Buffer before trying again. The local Node server's duplicate protection is in memory only. Do not overwrite the existing encryption key when updating a deployment. The Worker source, D1 schema and bundled assets are included in this repository; deploying new changes requires a separate upload to Cloudflare.

## Privacy and security

Buffer tokens are encrypted at rest and are not sent to the browser. Users can disconnect Buffer and delete their BuildLog data in the workspace. Deletion does not remove posts already in Buffer or revoke provider-side authorizations. Session expiration is seven days; revoking GitHub authorization does not immediately invalidate existing BuildLog sessions. Rate limiting, robust session management, and further production security review remain outstanding.

See [DEMO.md](DEMO.md) for the demo checklist and [SUBMISSION.md](SUBMISSION.md) for draft submission copy.
