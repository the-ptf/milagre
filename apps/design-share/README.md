# Public Designs and Artifact pages

This Worker publishes a snapshot of the entire Chat Designs page under one link. Sharing again replaces that snapshot under the same link. A page can hold up to 20 saved designs and 5,000 layers, with an 8 MiB JSON limit and 50,000 text characters across the page. It has no endpoints for sharing a selected design or element. The public page contains the design content and public title, without Chat messages, Project paths, comments or local identifiers.

An Artifact snapshot instead contains exactly one HTML page, limited to 1,000,000 characters and the same 8 MiB request/render budgets. It stays as published until the owner shares again, even though the local Artifact is updated in place.

The production service is deployed at `https://share.milagre.cloud`. The host checks its health before offering publication or creating a snapshot. A localhost preview is never a public link.

## Protocol

1. The host generates 32 cryptographically random bytes. Its unpadded base64url encoding is the management secret. The page ID is the unpadded base64url encoding of SHA-256 of those **decoded bytes**. Both strings contain 43 characters.
2. After the person confirms the public publishing notice, the host sends `PUT /api/pages/<id>` with `Authorization: Bearer <secret>`, `Content-Type: application/json`, and the complete validated page snapshot. The JSON response is `{id,path:"/s/<id>"}`. A new snapshot returns 201. An identical canonical payload retried under the same capability returns 200 without spending quota. Changed content under the same capability replaces the stored page and returns 200. It spends its bytes and one daily per-IP update, never a publication, so updating a live Artifact cannot lock out new links.
3. `GET /s/<id>` returns the read-only viewer. GET and HEAD tolerate tracking query parameters; write routes reject query parameters. It stays available while the owner Mac is offline. The response never includes the management secret or source JSON. Later edits stay private until the owner sends another PUT under the same ID.
4. `DELETE /api/pages/<id>` with the same authorization deletes the stored viewer and leaves a tombstone. It returns 204, including repeated deletes. GET returns 404 afterward. Reusing a revoked ID for PUT returns 410. Deleting a missing ID also reserves a tombstone, so a delayed upload cannot publish after cancellation. This new tombstone spends one quota reservation and 1 KiB of the byte budget; exhaustion returns 429 without claiming revocation succeeded. Deleting an existing page never needs another reservation.

The secret belongs in the host's private local storage. It must never appear in a URL, renderer state, public response or logs. This is capability authorization: anyone holding the secret can revoke that one page. The public page ID does not grant management access. Losing the secret loses the ability to revoke the hosted page. Copies someone downloaded cannot be revoked.

Mutation requests with an `Origin` header are refused, including same-origin browser requests. No CORS headers or browser publishing API are provided. The service uses only `CF-Connecting-IP` set by Cloudflare ingress for quota identity; it ignores forwarded and caller-provided internal IP headers. Custom hostnames are restricted by `PUBLIC_ORIGIN`. A local HTTP preview requires `ALLOW_LOCALHOST=true` and a loopback hostname.

## Storage and limits

Each page is a SQLite-backed Durable Object. It stores generated HTML as 96 KiB byte chunks and a small metadata record containing the canonical payload digest and a revision number. Chunk keys include the revision (pages published before revisions existed keep unversioned keys). One transaction commits all chunks and metadata atomically; a replacement also deletes the previous revision's chunks in that transaction, so a page never holds more than one version. Deletion removes the chunks atomically and retains a permanent tombstone. Generated HTML is limited to 8 MiB. Public responses pull one chunk at a time from storage instead of buffering the full page per reader. Every pull checks for revocation and for a newer revision: a reader that started on a replaced version ends with an error instead of receiving a page mixed from two versions. Source JSON is validated and rendered in memory, then discarded. The text character budget prevents narrow text boxes from expanding into unbounded SVG lines before the output limit can be checked.

A separate Durable Object serializes durable quota reservations. Defaults in `wrangler.toml` allow 2,000 publications per UTC day globally, 200 per ingress IP per day, 2,000 replacements per ingress IP per day, and 100,000 publications or 20 GiB of admitted content over the service's lifetime. The byte reservation includes canonical JSON plus rendered HTML, so it conservatively bounds stored content. Replacements count only against the byte budget and their own daily IP counter. Daily IP counters store hashes salted with the date, not raw addresses. They are cleared on the next day's first reservation. The limits can be lowered or raised within the bounded ranges in `quotaLimits`.

New uploads check the durable global and per-IP quota before reading or parsing their body. A replacement can only be told apart from an identical retry after hashing, so it runs the same admission check after validation and before rendering. This admission check spends nothing; the later atomic reservation enforces the final byte budget. Identical successful retries do not spend another reservation. Replacing a page never refunds the bytes of the version it replaces. A crash after reserving but before storing may spend the budget twice on retry. Revocation does not refund bytes or count. These conservative limits prevent failed writes or create/delete loops from bypassing the budget. The small tombstone also counts toward the lifetime publication count.

This first version permits anonymous creation protected by per-page capabilities and service-wide admission limits. It does not establish a publisher's identity, account ownership or reputation. An attacker can exhaust the shared budget and deny further publications. IP limits also group people behind one NAT. Before a public launch, configure Cloudflare ingress rate limits for request traffic, confirm the initial storage budget and provide an operator abuse/takedown process. Application quotas bound accepted publications; they do not cap requests, rendering CPU or public page traffic. The design service has no access to the phone relay, local MCP or Project management.

## Link previews

Public GET responses include Open Graph and Twitter card metadata, read by preview bots that ignore robots.txt: the published title, a description of the page, the canonical snapshot URL without tracking parameters, and a branded 1200 × 630 PNG at `/og.png`. The image is bundled into the Worker and contains no snapshot or Chat content. Regenerate it with `node scripts/share-og.cjs`.

The description is fixed at publication and stored in the page's own `<meta name="description">`, at most 200 characters. An Artifact uses its own meta description, or else its visible text with scripts, styles and a repeated title removed. A Designs page lists its design names, or for a single design the text of its visible layers. Pages published before descriptions existed, and pages with no text, keep a generic line.

Metadata is inserted into the first streamed HTML chunk at read time, so existing links receive it without changing their stored snapshot or capability. Original bytes are preserved across UTF-8 chunk boundaries. Revoked pages still return 404 without preview metadata. Sharing apps may retain an earlier preview in their own cache after a deployment or revocation.

## Viewer security

The shared renderer generates HTML from validated structured documents. A public page has no header or footer: the canvas, or the Artifact's frame, fills the window, and the only chrome floats in the bottom-right corner. Designs pages get a zoom bar like the desktop Canvas's (zoom out, the zoom reading that resets to 100%, zoom in, Fit) beside a Milagre logo that links to milagre.cloud; Artifact pages get the logo alone. The chrome is part of the HTML generated at publication, not added when the page is read, so pages published earlier keep their old header and footer until they are shared again. External image URLs are refused; the host embeds supported raster assets before upload. The page CSP permits embedded images, inline styles and the fixed pan/zoom controller, with no external network access, forms, framing or base URL changes. Responses disable caching and referrers and request search engines not index the page. `/robots.txt` disallows every path for every crawler. Link preview bots that honor it (Slack, Twitter/X, LinkedIn) unfurl a bare URL; Discord and Facebook ignore it and still show the preview. `noindex` is a crawler preference, not an access control. Anyone with a public URL can read or redistribute its content.

Public HTML Artifacts run inside an opaque `srcdoc` iframe with only `allow-scripts`. The wrapper's HTTP CSP is inherited: inline interaction is allowed, remote resources and nested frames are blocked, and the sandbox denies access to the parent origin, cookies, storage, forms, popups, downloads and top navigation. `frame-src 'none'` blocks self navigation while permitting the initial inline document. Escaped titles and `srcdoc` attributes keep arbitrary Artifact source inside the frame. The host does not fetch or embed external resources for Artifacts, so shared pages must be self-contained. The full HTML source, including hidden content, is public.

## Check and preview

```sh
node --test apps/design-share/src/*.test.mjs
npx tsc --noEmit -p apps/design-share/tsconfig.json
cd apps/design-share
npx -y wrangler@4.147.0 dev --local-upstream localhost --var ALLOW_LOCALHOST:true
```

The local preview uses local Durable Object storage. It does not upload snapshots to Cloudflare. Production deployment uses the private Cloudflare environment described in the repository instructions; do not copy credentials into this app.

Cloudflare references: [SQLite-backed storage](https://developers.cloudflare.com/durable-objects/api/sqlite-storage-api/) and [Durable Object limits](https://developers.cloudflare.com/durable-objects/platform/limits/).
