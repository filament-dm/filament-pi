# Build brief for Codex: `filament-pi`

You are building the package specified in `SPEC.md` in this directory. Read `SPEC.md` in full first, then `skills/filament/references/protocol.md`. The spec has been through six read-only review passes; build what it says, and where it is silent, choose the simplest behaviour consistent with its section 0 guarantee and say so in `BUILD-NOTES.md`.

## Ground truth
- Pi API: the installed Pi 1.0.0 declarations at `/Users/tonyhaile/.pi/agent/install/releases/1.0.0/node_modules/@earendil-works/pi-coding-agent/dist/` (`index.d.ts`, `core/extensions/types.d.ts`, `core/session-manager.d.ts`) and `/Users/tonyhaile/.pi/agent/install/releases/1.0.0/node_modules/@earendil-works/pi-agent-core/dist/types.d.ts`. Import types from `@earendil-works/pi-coding-agent`; import `Type` from `typebox`. Do not import anything that is not exported from those packages' roots.
- Working example of the exact wake pattern: `https://raw.githubusercontent.com/earendil-works/pi/main/packages/coding-agent/examples/extensions/file-trigger.ts` (session_start starts a watcher; `pi.sendMessage({customType, content, display: true}, {triggerTurn: true})` wakes the model). Tool registration example: `.../examples/extensions/todo.ts`.
- Filament protocol: `skills/filament/references/protocol.md` plus SPEC 1.3. The reference Python client that was built and tested against the live server is at `/Users/tonyhaile/Dropbox/Claude/Filament-Muse/skill/bin/filament` (read-only; port the handshake, error classification, retry and SSE-fallback logic, not the Muse-specific commands).
- Runtime: Node 22.21 (`node --version`), no Bun. TypeScript loaded by Pi through jiti at runtime; tests run with `node --experimental-strip-types --test test/` (or document another zero-dependency command that works here).

## Deliverables (SPEC section 2)
- `package.json`, `extensions/filament/{index,protocol,credential,state,lock,listener,render}.ts`, `skills/filament/SKILL.md` (SPEC section 6 verbatim as the rules, plus a short Purpose and a pointer to `/filament`), `test/fake-filament.ts`, `test/*.test.ts` covering every U and L test in SPEC 7.2 by name, `README.md` (humans: what it is, the three install commands, `/filament` commands, always-on with tmux, uninstall, where state lives, the stated guarantee in plain words), `BUILD-NOTES.md` (decisions you made where the spec was silent; anything you could not do and why; the exact test command and its passing output).
- Every file loads with no side effects at import time.

## Rules
- Never print, log or persist the access token. Tests must use a fake token under a temp agent dir (`PI_CODING_AGENT_DIR` or an injected agent-dir function).
- No runtime dependencies. No build step.
- Do not touch `~/.pi/agent/` on this machine, do not call the real Filament endpoint, do not start `pi`. Unit tests only; live tests are run separately.
- Keep functions small enough that the listener loop, the lock and the store can each be read in one screen. Comments say why, not what.
- Run the full test suite before you finish and paste the passing output into `BUILD-NOTES.md`. If any test in SPEC 7.2 cannot be made deterministic, implement it as far as possible and list it in `BUILD-NOTES.md` with the reason.
- Do not edit `SPEC.md`. If the spec is wrong or contradictory, implement the safer reading, and record the contradiction in `BUILD-NOTES.md`.
