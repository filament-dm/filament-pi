# Change request 1: adopt orphaned media-only messages (1 Oct 2026)

Observed live on prod with agent Pi Tony: a message consisting only of an image (body "", msgtype m.image, media present, from the principal) is never offered by `poll_work`. The next text message in the same channel arrives as a work item carrying only its own event id. `get_recent_messages` does return the media-only message, with `is_from_self: false`, `is_from_principal: true`, `media: [{mxc_url, msgtype, filename, mimetype, size, w, h}]`, `body: ""`, and `ts: null` (timestamps are null in that tool today). The server bug is being reported separately; this request is the client-side mitigation.

## Required behaviour (add to SPEC 4.7 semantics; do not edit SPEC.md, I will)
When enriching a batch (section 4.7), after fetching `recent` for the batch's channel (for backchannel batches the fetch of `cc_room_id` already happens):
1. Walk `recent` in the order the server returns it (oldest first as observed; verify by position of the batch's own ids and handle either order by locating the batch's ids).
2. Find the agent's most recent own message in the fetch (`is_from_self === true` or `sender === identity.user_id`). Candidates are messages positioned **after** that own message and **before or among** the batch's ids, with `is_from_self !== true`, `media` non-empty, body empty or whitespace, and event_id not in the replied store, not in inFlight, not parked in `unanswered`. If there is no own message in the fetch, candidates are all such messages positioned before the batch's last id.
3. Adopt each candidate into the batch: append its event_id to `batch.eventIds` (and to inFlight), append it to `batch.messages` with the sender and an empty body, and download its media under the same per-batch limits (3 downloads per batch in total, 20 MB each). The render then shows `[attachment: …]` lines for them in message order.
4. Adoption must happen inside the store mutex section that reserves ids, or be re-checked against the store after enrichment, so an adopted id cannot be reserved twice by two batches of the same poll.
5. `filament_reply` for that batch records the adopted ids as replied/acked exactly like the batch's own ids (no change needed if they are in `eventIds`).
6. Render note: when a batch contains adopted messages, add one line after the messages: `(An image-only message above was attached to this batch because Filament delivers it without text.)`

## Tests
- L25 adoption: fake server returns a text work item whose channel history (get_recent_messages) holds, after the agent's last own message, a media-only message from the principal; the delivered batch has two ids, one attachment line, the file downloaded; the reply records both ids; a later poll returning the same media-only message in history does not adopt it again.
- L25b no own message in history → adoption still works; media-only message from the agent itself is never adopted; a media-only message already in the replied store is never adopted; adoption respects the 3-download cap.
- Update L16 render if needed for the note line.

## Constraints
- Keep every existing test passing. Do not touch SPEC.md, BUILD-BRIEF.md, README.md beyond one sentence in README's attachments paragraph. Add a dated entry to BUILD-NOTES.md describing the change and paste the passing test output. Do not commit (I will).
