# DevSpace Portable dev86 validation — 2026-09-17

## Trigger

dev85 completed a real model-signed automatic continuation and full source regression. A subsequent real synthetic generation 3 remained active from `2026-09-17T01:22:52.816Z` until the user manually took over at `2026-09-17T01:47:13.659Z` (about 24m20.8s after ACK). Its substantive activity count increased from 34 to 170, so this was not the historical "no thinking / no tools" failure. The ChatGPT transcript nevertheless showed a long run of tool cards without useful visible progress text.

## Root cause

The first synthetic `continuation_task status` ACK used this mandatory execution wording:

`ACK/status is not work. Do not answer, summarize progress, return an empty final, or stop after this ACK.`

The intended rule was to forbid an ACK/status/progress-only **final**. The wording also forbade "answer" and "summarize progress" without distinguishing an in-turn progress update from a final response. Together with the hidden sustained-work instructions, a resumed model could reasonably choose silent tool-only execution for an entire long Host turn.

## dev86 change

- Keep `CALL_SUBSTANTIVE_DEVSPACE_TOOL_NOW` and all existing synthetic sustained-work gates.
- Keep status/progress-only finals, blank finals and placeholder "still working" finals forbidden.
- Explicitly allow and encourage occasional concise user-visible progress updates during sustained synthetic work.
- Define those messages as in-turn updates only: they must not reveal private chain-of-thought, must not become a completion boundary, and must be followed by further substantive DevSpace work while runnable milestones remain.
- Add focused guard and wire-contract assertions for this distinction.

## Validation state

- `test-continuation-guard.mjs`: passed after the source change.
- `test-continuation-architecture.mjs`: passed after the source change.
- `test-continuation-wire-contract.mjs`: currently blocked by its intentional canonical-package precondition because `app/node_modules/@waishnav/devspace` still contains dev85 until the core package is rebuilt/reinstalled. This is not a semantic test failure.

Before D-live deployment, dev86 still requires canonical package rebuild/install, wire regression, source verification/full regression, manifest/hash finalization and rollback-safe live deployment. A fresh real synthetic continuation must then demonstrate both sustained substantive work and visible in-turn progress without reintroducing a progress-only final.
