# Messages queued on the sending device

Issue [#783](https://github.com/the-ptf/milagre/issues/783). Desktop and mobile keep an outbox on the device where the user presses Queue message. The computer still owns the Project, Worktrees and Chat transcript. A local queue item is not a transcript receipt.

## History

The checked-in [October 8 computers design](../superpowers/specs/2026-10-08-computers-design.md), including its references to `sidebar-c-sections` v3, specifies a disabled composer and explicitly says "nothing is queued". Commit `1cc2acbf` (#354) implemented that policy. The prior orange notice/automatic outbox alternative was not found in the checked-in implementation history. The existing agent-turn queue and short-lived transport retries do not persist a message on the sending device while its computer is offline. This changes the product policy; it does not restore a removed outbox.

## Delivery contract

The orange notice names the offline computer. Both composers remain usable. Pressing Queue message saves the body, provider/model/options, computer and owner, Chat/Worktree destination, stable client message ID, and picked attachment bytes before clearing the submitted draft. Storage failure leaves the draft and attachments intact. Editing the next message while persistence finishes does not clear the new text or attachments.

Desktop uses an IndexedDB transaction with strict durability and a revision check. Mobile uses versioned files in the existing Expo document directory, verifies the temporary file, then moves it into place. The latest committed revision is authoritative. An unreadable latest revision blocks delivery without overwriting it or resurrecting a canceled message from an older revision. No native dependency, background service or runtime fingerprint change is needed.

Delivery runs while desktop Milagre is open, or while mobile Milagre is in the foreground. The queue checks every 15 seconds, on desktop computer changes and on mobile foreground/paired-computer changes. Existing Chat messages are delivered in order per computer/owner/Chat. Other Chats and computers proceed independently. Each submission from New Chat creates its own Chat; its messages wait in that Project's New Chat composer until the computer returns the saved Chat ID. The device queue is not synchronized to other devices.

Before remote mutations, delivery opens the original owner and reads `chat:send-status`. A saved receipt completes the local item without another upload or send. Otherwise, the send uses its original `clientMessageId`, and Links also reuse their original `operationId`. The host already persists these IDs and deduplicates concurrent/repeated sends, including messages waiting in its agent-turn queue. Computers without receipt support fail visibly before any mutation. Existing direct online sends retain their current behavior; the durable path covers offline/reconnecting sends and messages behind an existing queued Chat message.

## State and recovery

- **Queued on this device** means the device saved the message. Cancel removes it durably before delivery starts.
- **Sending** means delivery is in progress. **Sent** means the computer saved it, not that the agent finished. Open Chat navigates to the resulting Chat from the owner's screen. Dismiss removes the local receipt.
- A lost send acknowledgement retains the same ID and shows Check delivery. Cancellation is unavailable once dispatch may have happened; the outbox reconciles the receipt before retrying. It never claims to cancel an accepted message.
- **Needs attention** keeps the body and attachments. A rejected pre-send target can be retried, canceled, or recovered to the currently open Chat in the same owner. Missing/archived targets are never silently replaced. Removed computers' items remain reachable in the global device queue for cancellation; re-pairing does not retarget them automatically.
- Worktree creation has no idempotency key. Its intent is saved before the request, and its resulting Chat is saved before uploading or sending. An interrupted creation is never replayed automatically: check the computer, then Recover to this Chat. Canceling the message does not delete any Worktree that creation may have produced. Storage errors pause dispatch and expose Retry saving.

There is no separate outbox screen: waiting messages live in the Chat they were written in, in a tray around its composer (with the offline computer's chip), and the Chat's sidebar row says how many wait. Delivered copies are dropped once their Chat shows them. Removing or forgetting a computer discards its waiting messages after saying how many. This queue remains separate from the computer's agent-turn queue.

## Attachments

Picked files and pasted images are copied into the durable record. Desktop files picked while offline stay local until enqueued or sent after reconnect. Uploads occur only against the recorded computer and owner. Project file mentions retain their remote paths; no local machine reads a remote Project path. Missing picked bytes fail without clearing the composer. Attachment upload failure retains the queued copy; retries can upload another temporary copy but never start a duplicate turn. Sent records release their attachment bytes. Queue capacity follows the device's available storage; storage errors preserve the draft.

## Verification

Shared tests cover persistence, restart, order, separate computers/Chats, lost acknowledgement receipts, cancellation, malformed storage, write failure after acceptance, uncertain creation recovery, attachment upload, missing/archived targets and Link identities. Desktop's computer-screen check covers offline compose/queue/reconnect; mobile screen tests cover saving attachment bytes and preserving the draft after a write failure. Real-provider iOS verification uses a separate disposable Project and profile: queue, terminate/relaunch, reconnect, one persisted user message and reply, then cancel a second item and restart. No fake-provider screenshot is used as PR evidence.
