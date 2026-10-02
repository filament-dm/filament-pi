# filament-pi v0.1.0 build notes

Implemented the package, seven extension modules, standing skill, fake Filament server, tests and README. SPEC.md, BUILD-BRIEF.md and the protocol reference were not modified. Additional test support files are `test/helpers.ts` and `test/child.ts`; nothing outside the requested package was changed.

## Ground truth and limits

- Read BUILD-BRIEF.md first, all of SPEC.md v8, then the protocol reference. Read the specified installed Pi 1.0.0 declarations and the reference Python client's handshake, SSE, identity and error/retry code. Also checked the installed package documentation for package discovery and uninstall syntax. Installed files were read-only; no credentials or user settings under `~/.pi/agent` were read or changed.
- Node used: `v22.21.0`. No installs, external HTTP requests, real Filament calls or Pi process launches. The remote example URLs were not fetched; registration and wake signatures were checked against the installed declarations.
- All U1-U3 and L1-L24 have named tests. There are 75 passing tests, no skips or todos. The tests cover the registered tools/events through stubs, not just standalone helper methods.
- Tests T0-T17 are deliberately not run: these require Pi and/or production interaction, prohibited for this build. Actual Pi loading, model wake behaviour, MCP bypass interception in a running Pi and production response shapes therefore remain the live release gate. No TypeScript compiler was installed or available on PATH; syntax and behaviour were verified with Node's type stripping, with API signatures checked against the declarations. There is no claim of a separate static typecheck.

## Decisions and readings

1. **Version precedence.** SPEC v8 sections 4, 6 and 7 take precedence over the brief's older review-count description and the reference client's old bounded-store behaviour. No journal compaction or id eviction is implemented.
2. **Successful attempts.** Section 4.9 says to prune posted attempts, while 4.5 forbids journal rewrites. A `posted` tombstone is appended and the attempt is removed from the in-memory recovery view. Its physical history stays in the journal. Unresolved attempts have no limit.
3. **Shutdown binding.** Section 4.1 allows an active reply five seconds to record its result, while 4.13 rejects completions after run abortion. Separate polling and final-run abort controllers stop polls/heartbeats immediately but keep an admitted reply valid during the grace period. After five seconds, ownership and final validity are revoked. A late completion cannot write; next-owner reconciliation supplies the unknown outcome.
4. **Unpause ordering.** Explicit start ignores the pause for admission, but removes `paused.json` only after acquiring ownership and passing a write probe. This follows 4.13's ownership requirement for state mutations rather than unlinking another owner's pause before admission.
5. **Durability and permissions.** Journals use a single O_APPEND write per record followed by fsync, with a second ownership check immediately before that write. Suppression writes are under 4 KB. New state directories use 0700 and files 0600. Small metadata files use a unique temporary file, fsync, ownership recheck and atomic rename. A fresh write probe runs on every acquired start.
6. **Interrupted journal lines.** Before appending, the writer checks whether the existing final byte is a newline. If not, it prefixes a newline to the same append operation so a partial record cannot swallow the next valid one. Corruption quarantine names include a timestamp and random suffix. Empty files are empty stores; malformed non-empty lines are warned about and skipped; wholly unparseable journals are quarantined. Attempts use the same parsing policy, with an explicit recovery-history notice.
7. **Endpoint metadata.** Suppression, attempts, hello and pause records carry the endpoint. The incarnation file remains the specified JSON integer and lock files retain their prescribed ownership structure. Suppression remains keyed by event id across the agent directory; recovery additionally checks endpoint and agent identity. The HTTP client removes a trailing endpoint slash before deriving heartbeat and media URLs; credential lookup uses the configured full URL.
8. **Process identity.** Incarnation allocation is deferred until the first successful lock acquisition, so importing the package, print/json modes and losing contenders do no counter I/O. Allocation happens under listener ownership. The factory keeps incarnation, nonce, reply counter, name cache, notices and the active listener in a process-global symbol keyed by state directory, surviving extension reloads. Reload stops the previous instance. Standalone Listener instances in tests represent separate process contexts unless supplied the shared process state; a real child-process test also verifies the durable counter and stale transcript key.
9. **Generation changes during startup.** If a generation change interrupts state preparation, the same owner repeats preparation under the new generation before polling. Each operation still captures its generation by value.
10. **Settings.** Non-finite or non-numeric numeric settings use defaults; finite numbers are truncated to integers. `contextMessages` is clamped to 1-100. Only literal `false` disables auto-start. Malformed or unreadable settings/credential files stop startup with a generic storage error; unknown settings are status warnings.
11. **Credential hygiene.** The client keeps the credential in a private field and exposes no credential accessor. Untrusted HTTP/error bodies are not included in exception messages. Exact credential echoes in JSON/SSE response text are redacted before decoding. Redirects are refused, avoiding forwarding credentials to another location. Transport, filesystem and status messages do not expose the credential.
12. **Protocol deadlines.** Request deadlines include response-body reading. Concurrent handshake requests share one handshake; failures allow a later handshake retry. The initialise/initialised pair has a combined 15-second budget. No request primitive retries by itself; the listener owns read retries and a reply/resend makes exactly one request.
13. **Malformed responses.** Missing/malformed tool content, MCP `isError` results without a JSON-RPC error and non-object decoded results are unclassified failures. Read calls retry; write calls become unknown. Valid JSON-RPC rejections retain only the numeric error code in their user-facing message. This avoids reflecting arbitrary server content or credentials into errors.
14. **Identity and context shapes.** `get_self` must provide a string `user_id`; otherwise connection retries. Agent names fall back to the mxid localpart and owner names to “principal”. Context accepts arrays, `{messages}` or `{events}`; profiles use `user_id`, recent messages use `channel`, and threads use `message_id`.
15. **Heartbeat scheduling.** Heartbeat and refresh timers run on fixed intervals independent of enrichment and polling. Overlapping executions of the same timer are skipped. Heartbeat failures are noticed once; authentication failures pause, and failures persisting that pause are caught as storage errors.
16. **Enrichment.** Each poll's items share one 20-second deadline and three workers. Missing profile names fall back to localparts. Context-rendering drops oldest recent-context entries, then oldest thread entries, until the combined text fits 6,000 characters. MCP authentication errors during enrichment pause the listener; media HTTP errors only make that attachment unavailable.
17. **Media.** Downloads are deduplicated by mxc URL within a batch, with at most three distinct downloads. PNG/JPEG/GIF/WebP/PDF receive known extensions; other formats use `.bin`. Filenames never control local paths. Bytes are streamed with the hard 20 MiB limit, then saved only if the operation remains valid. A media mutex and per-batch path references prevent one batch deleting another's shared attachment. Consumption, stranding, generation changes and discarded partial enrichment clean up their references.
18. **Rendering and reply validation.** Sender names, context and incoming text have raw mxid server suffixes removed for model-facing rendering. Input reply validation additionally rejects HTML tags, following section 6's explicit no-HTML rule. Duplicate `also_keys` are deduplicated. An invalid body or invalid/cross-channel key leaves batches open. Timestamps render in the local timezone; invalid timestamps say “unknown time”.
19. **Reservation and acknowledgement.** The store mutex serialises reply/resend transactions, including the send, and batch reservation. An ack stores local suppression and audit data before the zero-wait poll. A failed server ack reports that local acknowledgement succeeded but the server acknowledgement is unavailable. Work returned by the ack request is processed after releasing the mutex, avoiding recursive locking.
20. **Recovery and notices.** Unknown and rejected records stay visible; interrupted attempting/resending records become unknown only after uncertain suppression is written. Status also exposes an active attempting/resending entry if queried mid-operation. Notice deduplication is by condition per process; waiting-for-naming and the eventual persisted naming pause are separate conditions, each noticed once.
21. **Model/run bookkeeping.** Newly reserved batches have no finite delivery time until enrichment completes. Nudging replaces the batch state and refreshes its delivery time so a repeated settle for the same run cannot immediately strand its own nudge. The strict delivered-before-run comparison follows section 4.3.
22. **Status and commands.** Both modes receive one structured `filament-status` custom message per command. Tui additionally receives one line via notify; rpc never calls notify. Status contains a one-line recovery instruction when applicable. Unknown subcommands return command usage. Read-only status performs no credential or filesystem reads.
23. **Import and package loading.** Runtime peer imports are deferred to the extension factory; root-package type imports are erased. Only `index.ts` is listed as the extension entry, so support modules are not registered independently. Factory registration starts no timers, sockets or state I/O.
24. **Fake transport.** The fake implements the HTTP/JSON-RPC subset and optionally exposes a local HTTP listener. This suite invokes its Fetch transport directly, avoiding even loopback sockets while exercising the same request envelopes, headers, response bodies, delays and error classification. Credentials are fake and stored only in temporary agent directories. Child processes are confined to those test directories.
25. **Timing and crash tests.** Protocol time, grace periods, backoff and deadlines use an injected fake clock. Filesystem completion and child-process barriers use bounded real waits. Crash boundaries are injected exceptions followed by owner shutdown/new-owner reconciliation; takeover races and reply-key incarnation also use real spawned Node processes. No test relies on the real Filament server consuming work. An initial full-suite run exposed overly short filesystem polling in the harness under parallel test load; waits were corrected without changing assertions.
26. **Documentation and scope.** README documents exactly three install commands, tmux operation, manual failover, commands, recovery caveats, persistent state and uninstall. The accepted 1,000-id minimum horizon, corruption/resend exceptions, probabilistic key collision and post-admission ownership window are preserved, not claimed solved.

## Verification

Exact zero-dependency command, run from the package directory with Node v22.21.0:

```sh
node --experimental-strip-types --test test/*.test.ts
```

The `test` npm script invokes that same command. Full passing output follows, unedited:

```text
TAP version 13
# Subtest: protocol: initialize, initialized, session echo, SSE last JSON, tool content decoding
ok 1 - protocol: initialize, initialized, session echo, SSE last JSON, tool content decoding
  ---
  duration_ms: 28.248
  type: 'test'
  ...
# Subtest: protocol: request deadlines include response body; redirects never followed; token echoes redacted
ok 2 - protocol: request deadlines include response body; redirects never followed; token echoes redacted
  ---
  duration_ms: 30.009833
  type: 'test'
  ...
# Subtest: factory registrations: no I/O, tools and handlers wired; print/json never start
ok 3 - factory registrations: no I/O, tools and handlers wired; print/json never start
  ---
  duration_ms: 214.548875
  type: 'test'
  ...
# Subtest: L21 actual new process: durable incarnation advances and transcript key is refused
ok 4 - L21 actual new process: durable incarnation advances and transcript key is refused
  ---
  duration_ms: 633.306167
  type: 'test'
  ...
# Subtest: L21 reload process state: same identity and monotonic key counter across extension instances
ok 5 - L21 reload process state: same identity and monotonic key counter across extension instances
  ---
  duration_ms: 224.003042
  type: 'test'
  ...
# Subtest: reply validation: empty, HTML, horizontal rule, raw id retain batch; member mention accepted
ok 6 - reply validation: empty, HTML, horizontal rule, raw id retain batch; member mention accepted
  ---
  duration_ms: 198.491
  type: 'test'
  ...
# Subtest: L2 additional keys: other channel or missing token refuses whole reply
ok 7 - L2 additional keys: other channel or missing token refuses whole reply
  ---
  duration_ms: 130.27375
  type: 'test'
  ...
# Subtest: hello: persisted once per credential; failed next-start retry; explicit hello always sends
ok 8 - hello: persisted once per credential; failed next-start retry; explicit hello always sends
  ---
  duration_ms: 271.032416
  type: 'test'
  ...
# Subtest: L13 heartbeat and hello old-generation auth completions cannot pause new session
ok 9 - L13 heartbeat and hello old-generation auth completions cannot pause new session
  ---
  duration_ms: 164.435625
  type: 'test'
  ...
# Subtest: L15 enrichment MCP auth pauses, media auth stays attachment-only
ok 10 - L15 enrichment MCP auth pauses, media auth stays attachment-only
  ---
  duration_ms: 127.759417
  type: 'test'
  ...
# Subtest: L23 persistence failure in hello and paused records closes listener and releases lock
ok 11 - L23 persistence failure in hello and paused records closes listener and releases lock
  ---
  duration_ms: 273.313875
  type: 'test'
  ...
# Subtest: L13 factory reload: old listener stopped, process identity and notice cache retained
ok 12 - L13 factory reload: old listener stopped, process identity and notice cache retained
  ---
  duration_ms: 388.636083
  type: 'test'
  ...
# Subtest: L23 heartbeat auth plus paused-store failure stops cleanly without unhandled rejection
ok 13 - L23 heartbeat auth plus paused-store failure stops cleanly without unhandled rejection
  ---
  duration_ms: 113.714
  type: 'test'
  ...
# Subtest: L13 generation: resume clears open batch, drops late enrichment, next poll redelivers
ok 14 - L13 generation: resume clears open batch, drops late enrichment, next poll redelivers
  ---
  duration_ms: 213.503084
  type: 'test'
  ...
# Subtest: L13 generation: session_tree clears open batch, drops late enrichment, next poll redelivers
ok 15 - L13 generation: session_tree clears open batch, drops late enrichment, next poll redelivers
  ---
  duration_ms: 127.099708
  type: 'test'
  ...
# Subtest: L13 generation: resync clears open batch, drops late enrichment, next poll redelivers
ok 16 - L13 generation: resync clears open batch, drops late enrichment, next poll redelivers
  ---
  duration_ms: 127.3735
  type: 'test'
  ...
# Subtest: L13 binding: new credential start ignores old poll 401 and remains listening
ok 17 - L13 binding: new credential start ignores old poll 401 and remains listening
  ---
  duration_ms: 227.395834
  type: 'test'
  ...
# Subtest: L13 binding: send after five-second shutdown writes nothing; next owner restores suppression
ok 18 - L13 binding: send after five-second shutdown writes nothing; next owner restores suppression
  ---
  duration_ms: 227.98125
  type: 'test'
  ...
# Subtest: L13 binding: send within shutdown grace records posted outcome
ok 19 - L13 binding: send within shutdown grace records posted outcome
  ---
  duration_ms: 158.513375
  type: 'test'
  ...
# Subtest: L13 recovery: interrupted resending becomes unknown; interrupted reconciliation is repeatable
ok 20 - L13 recovery: interrupted resending becomes unknown; interrupted reconciliation is repeatable
  ---
  duration_ms: 278.358
  type: 'test'
  ...
# Subtest: L14 stranded: one nudge, then unanswered across five settles; new input recombines, resync releases
ok 21 - L14 stranded: one nudge, then unanswered across five settles; new input recombines, resync releases
  ---
  duration_ms: 136.719625
  type: 'test'
  ...
# Subtest: L14 stranded: delivery during running turn evaluated only after following run
ok 22 - L14 stranded: delivery during running turn evaluated only after following run
  ---
  duration_ms: 110.094875
  type: 'test'
  ...
# Subtest: L15 enrichment: slow context text-only within deadline, next poll proceeds
ok 23 - L15 enrichment: slow context text-only within deadline, next poll proceeds
  ---
  duration_ms: 93.8955
  type: 'test'
  ...
# Subtest: L15 enrichment: ten slow items all delivered by batch-wide 20-second deadline, concurrency three
ok 24 - L15 enrichment: ten slow items all delivered by batch-wide 20-second deadline, concurrency three
  ---
  duration_ms: 125.626167
  type: 'test'
  ...
# Subtest: L15 enrichment: media 403 is unavailable, >20 MB cut off, successful file removed on reply
ok 25 - L15 enrichment: media 403 is unavailable, >20 MB cut off, successful file removed on reply
  ---
  duration_ms: 223.972833
  type: 'test'
  ...
# Subtest: L15 enrichment: independent heartbeat fires during slow enrichment
ok 26 - L15 enrichment: independent heartbeat fires during slow enrichment
  ---
  duration_ms: 136.422167
  type: 'test'
  ...
# Subtest: L16 render: no raw mxid; token, prior key and nudge header present
ok 27 - L16 render: no raw mxid; token, prior key and nudge header present
  ---
  duration_ms: 140.6585
  type: 'test'
  ...
# Subtest: L17 admission: lost lock refuses reply, ack and hello with no requests
ok 28 - L17 admission: lost lock refuses reply, ack and hello with no requests
  ---
  duration_ms: 155.320291
  type: 'test'
  ...
# Subtest: L18 bypass: direct posting always blocked, principal ping and reads allowed
ok 29 - L18 bypass: direct posting always blocked, principal ping and reads allowed
  ---
  duration_ms: 1.780125
  type: 'test'
  ...
# Subtest: L19 settings: missing defaults, wait clamp, unknown warning
ok 30 - L19 settings: missing defaults, wait clamp, unknown warning
  ---
  duration_ms: 200.968542
  type: 'test'
  ...
# Subtest: L20 rpc output: exactly one status message, structured details, no stdout
ok 31 - L20 rpc output: exactly one status message, structured details, no stdout
  ---
  duration_ms: 122.990167
  type: 'test'
  ...
# Subtest: L21 reply-key uniqueness: next incarnation rejects transcript key; same-process stop/start preserves identity
ok 32 - L21 reply-key uniqueness: next incarnation rejects transcript key; same-process stop/start preserves identity
  ---
  duration_ms: 210.61125
  type: 'test'
  ...
# Subtest: L21 forced collision: identical incarnation, nonce and counter resolves old instruction to current batch (accepted residual)
ok 33 - L21 forced collision: identical incarnation, nonce and counter resolves old instruction to current batch (accepted residual)
  ---
  duration_ms: 130.534917
  type: 'test'
  ...
# Subtest: L22 horizon: id older than 1,500 retained, corruption notice then delivery; 150 unresolved attempts retained
ok 34 - L22 horizon: id older than 1,500 retained, corruption notice then delivery; 150 unresolved attempts retained
  ---
  duration_ms: 172.474583
  type: 'test'
  ...
# Subtest: L23 startup: handshake 5xx twice retries, get_self timeout retries, explicit start overrides autoStart false
ok 35 - L23 startup: handshake 5xx twice retries, get_self timeout retries, explicit start overrides autoStart false
  ---
  duration_ms: 147.235666
  type: 'test'
  ...
# Subtest: L23 unclassified outcome: HTTP 418 HTML is unknown, never retried
ok 36 - L23 unclassified outcome: HTTP 418 HTML is unknown, never retried
  ---
  duration_ms: 162.593542
  type: 'test'
  ...
# Subtest: L23 persistence: EACCES stops, releases lock, refuses writes; start probes and recovers
ok 37 - L23 persistence: EACCES stops, releases lock, refuses writes; start probes and recovers
  ---
  duration_ms: 143.98975
  type: 'test'
  ...
# Subtest: L24 admission race: pre-send inode replacement refuses reply without request
ok 38 - L24 admission race: pre-send inode replacement refuses reply without request
  ---
  duration_ms: 135.289125
  type: 'test'
  ...
# Subtest: L1 delivery once: [A] polled three times gives one delivery
ok 39 - L1 delivery once: [A] polled three times gives one delivery
  ---
  duration_ms: 160.692667
  type: 'test'
  ...
# Subtest: L2 batches: immutable A and B follow-up, also_keys posts once and consumes both
ok 40 - L2 batches: immutable A and B follow-up, also_keys posts once and consumes both
  ---
  duration_ms: 202.630708
  type: 'test'
  ...
# Subtest: L3 B unseen: arrival during send becomes its own batch, never marked replied
ok 41 - L3 B unseen: arrival during send becomes its own batch, never marked replied
  ---
  duration_ms: 224.749625
  type: 'test'
  ...
# Subtest: L4 stale key: old answered key cannot reply to new batch in same channel
ok 42 - L4 stale key: old answered key cannot reply to new batch in same channel
  ---
  duration_ms: 186.8265
  type: 'test'
  ...
# Subtest: L5 parallel replies: same token sends once
ok 43 - L5 parallel replies: same token sends once
  ---
  duration_ms: 165.962125
  type: 'test'
  ...
# Subtest: L6 non-consuming server: ack offered, no redelivery, five second floor
ok 44 - L6 non-consuming server: ack offered, no redelivery, five second floor
  ---
  duration_ms: 164.232166
  type: 'test'
  ...
# Subtest: L7 ack: durable local ack, server acknowledged zero, work in response delivered
ok 45 - L7 ack: durable local ack, server acknowledged zero, work in response delivered
  ---
  duration_ms: 169.622583
  type: 'test'
  ...
# Subtest: L8 truncated: pages delivered in order without sleep
ok 46 - L8 truncated: pages delivered in order without sleep
  ---
  duration_ms: 120.586375
  type: 'test'
  ...
# Subtest: L9 errors: 5xx x3 yields 2/4/8 backoff, one notice; malformed counts; success resets
ok 47 - L9 errors: 5xx x3 yields 2/4/8 backoff, one notice; malformed counts; success resets
  ---
  duration_ms: 149.094541
  type: 'test'
  ...
# Subtest: L9 errors: auth {"status":401} pauses, releases lock and heartbeat, no more requests
ok 48 - L9 errors: auth {"status":401} pauses, releases lock and heartbeat, no more requests
  ---
  duration_ms: 134.690875
  type: 'test'
  ...
# Subtest: L9 errors: auth {"status":403} pauses, releases lock and heartbeat, no more requests
ok 49 - L9 errors: auth {"status":403} pauses, releases lock and heartbeat, no more requests
  ---
  duration_ms: 131.567833
  type: 'test'
  ...
# Subtest: L9 errors: auth {"error":-32001} pauses, releases lock and heartbeat, no more requests
ok 50 - L9 errors: auth {"error":-32001} pauses, releases lock and heartbeat, no more requests
  ---
  duration_ms: 114.786417
  type: 'test'
  ...
# Subtest: L9 errors: -32002 waits every 15 seconds, pauses after ten minute grace
ok 51 - L9 errors: -32002 waits every 15 seconds, pauses after ten minute grace
  ---
  duration_ms: 271.832458
  type: 'test'
  ...
# Subtest: L10 outcome map: missing event_id => unknown, consumes and saves target/body
ok 52 - L10 outcome map: missing event_id => unknown, consumes and saves target/body
  ---
  duration_ms: 214.652209
  type: 'test'
  ...
# Subtest: L10 outcome map: 5xx => unknown, consumes and saves target/body
ok 53 - L10 outcome map: 5xx => unknown, consumes and saves target/body
  ---
  duration_ms: 285.121834
  type: 'test'
  ...
# Subtest: L10 outcome map: bad arguments => rejected, consumes and saves target/body
ok 54 - L10 outcome map: bad arguments => rejected, consumes and saves target/body
  ---
  duration_ms: 138.318833
  type: 'test'
  ...
# Subtest: L10 outcome map: timeout => unknown, consumes and saves target/body
ok 55 - L10 outcome map: timeout => unknown, consumes and saves target/body
  ---
  duration_ms: 155.67675
  type: 'test'
  ...
# Subtest: L11 crash point: before-attempt
ok 56 - L11 crash point: before-attempt
  ---
  duration_ms: 145.576041
  type: 'test'
  ...
# Subtest: L11 crash point: after-attempt
ok 57 - L11 crash point: after-attempt
  ---
  duration_ms: 204.034834
  type: 'test'
  ...
# Subtest: L11 crash point: after-suppression
ok 58 - L11 crash point: after-suppression
  ---
  duration_ms: 217.542916
  type: 'test'
  ...
# Subtest: L11 crash point: after-outcome
ok 59 - L11 crash point: after-outcome
  ---
  duration_ms: 219.72825
  type: 'test'
  ...
# Subtest: L11 active send: second listener cannot reconcile the owner’s attempt
ok 60 - L11 active send: second listener cannot reconcile the owner’s attempt
  ---
  duration_ms: 138.118666
  type: 'test'
  ...
# Subtest: L12 resend: endpoint/identity mismatch refused, warning, resending before send, concurrent once, polling serialised
ok 61 - L12 resend: endpoint/identity mismatch refused, warning, resending before send, concurrent once, polling serialised
  ---
  duration_ms: 145.60675
  type: 'test'
  ...
# Subtest: L12 resend: rejection retains recovery record
ok 62 - L12 resend: rejection retains recovery record
  ---
  duration_ms: 169.996541
  type: 'test'
  ...
# Subtest: L12 resend: timeout retains recovery record
ok 63 - L12 resend: timeout retains recovery record
  ---
  duration_ms: 160.698334
  type: 'test'
  ...
# Subtest: U1 credential: documented key, legacy key, missing file, missing key; token only
ok 64 - U1 credential: documented key, legacy key, missing file, missing key; token only
  ---
  duration_ms: 46.95375
  type: 'test'
  ...
# Subtest: U2 store: append/lookup, last line wins, 1,500 ids, growing inode and lines, malformed and corrupt
ok 65 - U2 store: append/lookup, last line wins, 1,500 ids, growing inode and lines, malformed and corrupt
  ---
  duration_ms: 13597.317
  type: 'test'
  ...
# Subtest: U2 store: concurrent reservations and overlapping process append preserve both lines
ok 66 - U2 store: concurrent reservations and overlapping process append preserve both lines
  ---
  duration_ms: 248.121333
  type: 'test'
  ...
# Subtest: U3 lock: acquire, live pid refusal, dead pid and stale timestamp takeover
ok 67 - U3 lock: acquire, live pid refusal, dead pid and stale timestamp takeover
  ---
  duration_ms: 32.088875
  type: 'test'
  ...
# Subtest: U3 lock: two spawned contenders race stale takeover through shared start barrier
ok 68 - U3 lock: two spawned contenders race stale takeover through shared start barrier
  ---
  duration_ms: 255.765333
  type: 'test'
  ...
# Subtest: U3 lock: paused interleaving and delayed contender abandon replacement owner
ok 69 - U3 lock: paused interleaving and delayed contender abandon replacement owner
  ---
  duration_ms: 18.14925
  type: 'test'
  ...
# Subtest: U3 lock: marker O_EXCL and staggered unlink/create sequence is unreachable
ok 70 - U3 lock: marker O_EXCL and staggered unlink/create sequence is unreachable
  ---
  duration_ms: 15.037417
  type: 'test'
  ...
# Subtest: U3 lock: crashed marker is never reclaimed; explicit reset clears and acquires
ok 71 - U3 lock: crashed marker is never reclaimed; explicit reset clears and acquires
  ---
  duration_ms: 14.633375
  type: 'test'
  ...
# Subtest: U3 lock: malformed O_EXCL create before write recovers after 60 seconds, young file reread three times
ok 72 - U3 lock: malformed O_EXCL create before write recovers after 60 seconds, young file reread three times
  ---
  duration_ms: 24.9875
  type: 'test'
  ...
# Subtest: U3 lock: malformed refresh ftruncate before write recovers after 60 seconds, young file reread three times
ok 73 - U3 lock: malformed refresh ftruncate before write recovers after 60 seconds, young file reread three times
  ---
  duration_ms: 19.026
  type: 'test'
  ...
# Subtest: U3 lock: foreign inode refresh, release and admission refuse without modifying replacement
ok 74 - U3 lock: foreign inode refresh, release and admission refuse without modifying replacement
  ---
  duration_ms: 13.408666
  type: 'test'
  ...
# Subtest: U2 store: unterminated corrupt tail cannot swallow the next suppression record
ok 75 - U2 store: unterminated corrupt tail cannot swallow the next suppression record
  ---
  duration_ms: 16.360875
  type: 'test'
  ...
1..75
# tests 75
# suites 0
# pass 75
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 14984.014208
```

## Commit blocked by the sandbox

The requested commit was not created. After implementation and the passing full-suite run, this staging command failed:

```sh
git add package.json extensions/filament skills/filament/SKILL.md test README.md BUILD-NOTES.md
```

Exact error:

```text
fatal: Unable to create '/Users/tonyhaile/Dropbox/Claude/Filament-Pi/.git/index.lock': Operation not permitted
```

The supplied sandbox permits workspace edits but protects `.git` from writes, and broader permissions are forbidden. No bypass or escalation was attempted. All deliverables remain in the working directory, unstaged. The remaining action is to stage them and create the authorised commit in a session that can write this repository's Git metadata, using the exact message `filament-pi v0.1.0 build`.
