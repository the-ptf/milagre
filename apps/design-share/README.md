# Public Designs and Artifact pages

This Worker publishes a snapshot of the entire Chat Designs page under one link. Sharing again replaces that snapshot under the same link. Sharing has no per-page design count, layer count, text or byte quota. It has no endpoints for sharing a selected design or element. The public page contains the design content and public title, without Chat messages, Project paths, comments or local identifiers.

An Artifact snapshot instead contains exactly one HTML page, without an additional publication size quota. The normal local Artifact authoring schema still applies. It stays as published until the owner shares again, even though the local Artifact is updated in place.

The production service is deployed at `https://share.milagre.cloud`. The host checks its health before offering publication or creating a snapshot. A localhost preview is never a public link.

## Protocol

1. The host generates 32 cryptographically random bytes. Its unpadded base64url encoding is the management secret. The page ID is the unpadded base64url encoding of SHA-256 of those **decoded bytes**. Both strings contain 43 characters.
2. After the person confirms the public publishing notice, the host sends `PUT /api/pages/<id>` with `Authorization: Bearer <secret>`, `Content-Type: application/json`, and the complete validated page snapshot. The JSON response is `{id,path:"/s/<id>"}`. A new snapshot returns 201. An identical canonical payload retried under the same capability returns 200 without spending quota. Changed content under the same capability replaces the stored page and returns 200. It replaces the previous active byte charge. Identical PUTs and changed publications both renew the 30-day expiry.
   An Artifact snapshot may name files (`assets`: name, SHA-256 in hex, size, type) that its HTML shows as `assets/<name>`. Before the snapshot, the host uploads each with `PUT /api/pages/<id>/files/<sha256>`, the same authorization, its media type as `Content-Type` and its `Content-Length`: 201 when stored, 200 when the page already has it. The bucket refuses bytes that don't match their hash or length (400). A snapshot that names a file the page doesn't have returns 409 with `{missing:[...]}`. Files count toward the quota with the page's HTML (an upload past it returns 429) and are limited to 95 MB each, under Cloudflare's request body limit.
3. `GET /s/<id>` returns the read-only viewer. GET and HEAD tolerate tracking query parameters; write routes reject query parameters. It stays available while the owner Mac is offline. The response never includes the management secret or source JSON. Later edits stay private until the owner sends another PUT under the same ID.
   `GET /s/<id>/files/<sha256>` returns one of the page's files, whole or by one `Range` (a video player seeks with them).
4. `DELETE /api/pages/<id>` with the same authorization deletes the stored viewer and leaves a tombstone. It returns 204, including repeated deletes. GET returns 404 afterward. Reusing a revoked ID for PUT returns 410. Deleting a missing ID also reserves a tombstone, so a delayed upload cannot publish after cancellation. Revocation always works at quota exhaustion. A small permanent tombstone prevents delayed uploads from recreating the page; it holds no content allocation.

The secret belongs in the host's private local storage. It must never appear in a URL, renderer state, public response or logs. This is capability authorization: anyone holding the secret can revoke that one page. The public page ID does not grant management access. Losing the secret loses the ability to revoke the hosted page. Copies someone downloaded cannot be revoked.

Mutation requests with an `Origin` header are refused, including same-origin browser requests. No CORS headers or browser publishing API are provided. The service uses only `CF-Connecting-IP` set by Cloudflare ingress for quota identity; it ignores forwarded and caller-provided internal IP headers. Custom hostnames are restricted by `PUBLIC_ORIGIN`. A local HTTP preview requires `ALLOW_LOCALHOST=true` and a loopback hostname.

## Storage and limits

An Artifact page's files are kept in the R2 bucket bound as `FILES` (`milagre-design-share-files`), under `pages/<id>/<sha256>`. Each upload is a page operation on the same allocation ledger as a publication: reserve the page's new total, store the file, commit. A publication that no longer names a file removes it; revocation and expiry remove every file of the page; a file uploaded for a publication that never came is removed after an hour. Removals wait in the page's trash until R2 confirms them, retried by the page's alarm. Public file reads go to R2 directly, so a page's files stay readable between its expiry and the alarm that removes them.

Each page is a SQLite-backed Durable Object. Generated HTML is stored in 96 KiB chunks with revision metadata. A transaction replaces all chunks and metadata atomically. Public reads stream one chunk at a time, check the current revision and expiry on every pull, and stop if the link was revoked, replaced or expired. Source JSON is discarded after validation and rendering.

The only content quota is `MAX_TOTAL_BYTES`, configured to 20 GiB for the whole service. New allocations count canonical JSON plus rendered HTML. Replacements hold the larger of the previous and new charges until their storage transaction commits, then settle to the new charge. Revocation and expiry delete all content and return its entire allocation. There are no daily, per-IP, publication-count or lifetime-byte quotas. Schema validation, embedded-image restrictions, authorization and Cloudflare's physical runtime limits still apply. The normal design/Artifact authoring constraints are unchanged.

Pages expire 30 days after the most recent successful PUT, including identical republishing. Reads do not renew the deadline. Durable Object alarms delete content and refund quota while the owner Mac is offline. GET and HEAD return 404 afterward; an authorized PUT to the old capability returns 410. Both clients already recover from 410 through the shared host: publishing again creates a fresh link. No expiry or quota counter is added to either UI.

Quota uses a durable per-page allocation ledger. A page saves a pending operation and schedules a retry alarm before reserving bytes. Monotonic operation numbers fence delayed requests. Commit and abort are idempotent. Interrupted writes abort their reservation; committed writes settle it. Deletion stores a refund intent before contacting quota, so lost acknowledgements and service failures retry without double refunds. A failed cleanup keeps its allocation until the refund completes. Tombstones retain no content charge. They and the ledger have small metadata storage costs outside the content cap.

### Upgrade existing hosted pages

The old lifetime counter cannot identify active pages or recover discarded source JSON. When that counter exists, new uploads are blocked until a one-time inventory completes. Reads and revocations continue. Inventory charges legacy pages for their surviving HTML, preserves their links, and gives them 30 days from inventory; subsequent publications use canonical JSON plus HTML as above. If existing content is already over the cap, uploads stay blocked until content is removed or expires.

1. Deploy this Worker with a temporary, random `MIGRATION_TOKEN` secret. Keep the token out of command arguments, logs and commits. The maintenance routes return 404 when this secret is absent.
2. Load the Cloudflare account/token environment and set `SHARE_PAGES_NAMESPACE_ID` to this Worker's `DesignPage` namespace ID. Set the same `MIGRATION_TOKEN` in the script environment. The Cloudflare token needs read access to Durable Object namespaces and objects.
3. Run `node apps/design-share/scripts/migrate-active-quota.mjs` from the repo root. It inventories every stored object, installs expiry alarms and only enables uploads after all imports succeed. Failures leave uploads blocked; rerunning is safe. `SHARE_ORIGIN` optionally selects another HTTPS deployment.
4. Remove the Worker's temporary `MIGRATION_TOKEN` secret after success. Fresh services without the legacy counter need no inventory.

The operator-only inventory is never exposed to clients. Application quotas bound accepted content, not request traffic or rendering CPU. Configure Cloudflare ingress controls separately if needed.

## Link previews

Public GET responses include Open Graph and Twitter card metadata, read by preview bots that ignore robots.txt: the published title, a description of the page, the canonical snapshot URL without tracking parameters, and a branded 1200 × 630 PNG at `/og.png`. The image is bundled into the Worker and contains no snapshot or Chat content. Regenerate it with `node scripts/share-og.cjs`.

The description is fixed at publication and stored in the page's own `<meta name="description">`, at most 200 characters. An Artifact uses its own meta description, or else its visible text with scripts, styles and a repeated title removed. A Designs page lists its design names, or for a single design the text of its visible layers. Pages published before descriptions existed, and pages with no text, keep a generic line.

Metadata is inserted into the first streamed HTML chunk at read time, so existing links receive it without changing their stored snapshot or capability. Original bytes are preserved across UTF-8 chunk boundaries. Revoked pages still return 404 without preview metadata. Sharing apps may retain an earlier preview in their own cache after a deployment or revocation.

## Viewer security

The shared renderer generates HTML from validated structured documents. A public page has no header or footer: the canvas, or the Artifact's frame, fills the window, and the only chrome floats in the bottom-right corner. Designs pages lay their frames out as the desktop Canvas does: one row, or once any design names a group, one named block per group stacked down the page. They get a zoom bar like the desktop Canvas's (zoom out, the zoom reading that resets to 100%, zoom in, Fit) beside a Milagre logo that links to milagre.cloud; Artifact pages get the logo alone. The chrome is part of the HTML generated at publication, not added when the page is read, so pages published earlier keep their old header and footer until they are shared again. External image URLs are refused; the host embeds supported raster assets before upload. The page CSP permits embedded images, inline styles and the fixed pan/zoom controller, with no external network access, forms, framing or base URL changes. Responses disable caching and referrers and request search engines not index the page. `/robots.txt` disallows every path for every crawler. Link preview bots that honor it (Slack, Twitter/X, LinkedIn) unfurl a bare URL; Discord and Facebook ignore it and still show the preview. `noindex` is a crawler preference, not an access control. Anyone with a public URL can read or redistribute its content.

Public HTML Artifacts run inside an opaque `srcdoc` iframe with only `allow-scripts`. The wrapper's HTTP CSP is inherited: inline interaction is allowed, remote resources and nested frames are blocked, and the sandbox denies access to the parent origin, cookies, storage, forms, popups, downloads and top navigation. `frame-src 'none'` blocks self navigation while permitting the initial inline document. Escaped titles and `srcdoc` attributes keep arbitrary Artifact source inside the frame. The host does not fetch or embed external resources for Artifacts, so shared pages must be self-contained: the files a page shows are uploaded with it, and its policy lets it load images, media and fonts from this origin only. Files are served with `Content-Security-Policy: default-src 'none'; sandbox` and `nosniff`, and anything but images, video, audio, fonts, plain text and PDF as a download, so a file never runs as a page of this origin. The full HTML source and every file it names, including hidden content, are public.

## Check and preview

```sh
node --test apps/design-share/src/*.test.mjs
npx tsc --noEmit -p apps/design-share/tsconfig.json
cd apps/design-share
npx -y wrangler@4.147.0 dev --local-upstream localhost --var ALLOW_LOCALHOST:true
```

The local preview uses local Durable Object and R2 storage. It does not upload snapshots or files to Cloudflare. Before the first deployment with files, create the bucket once: `npx -y wrangler@4.147.0 r2 bucket create milagre-design-share-files`. Production deployment uses the private Cloudflare environment described in the repository instructions; do not copy credentials into this app.

Cloudflare references: [SQLite-backed storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) and [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/).
