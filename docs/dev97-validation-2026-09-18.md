# Dev97 continuation regression repair — 2026-09-18

## Scope

Continue the current implementation as 1.1.59 dev97. Do not reset to a prior
commit. No Release or tag publication is authorized until stability is verified.
All source work remains in E:\program\Python\DevSpaceDeploy.

## Evidence

- Yesterday's dev85 generation 3 ran about 24m20.8s and increased substantive
  activity from 34 to 170, as recorded in dev86 validation.
- The dev90 pre-release snapshot retains the compact manual-like continuation
  trigger; dev90 itself did not change continuation authorization.
- Today's generation 23 ACKed at 08:52:43.603Z, made only one substantive
  operation (930 to 931), last worked at 08:53:07.162Z, and was retired at
  08:55:08.514Z as synthetic-underfloor-stall-recovered. Background strict-stop
  progress from 2/12 to 5/12 was not sustained model execution.
- The previous 12-run strict-stop process finished at 08:57:20.198Z with exit 0.
- Current code allowed unfinished synthetic turn-complete after four operations
  with no server-enforced stage boundary. Chinese visible text invited a stage
  summary while English visible text required continuous tool work.
- The dev96 120-second quiet threshold could also retire legitimate long
  reasoning before four tools. Its 100/110-second protection fixture did not
  test the unsafe side of that boundary.

## Change

- Restore compact, consistent Chinese/English continuation triggers while
  retaining the one-time origin ACK, bounded resume capsule and current sender
  revision checks.
- Reject unfinished synthetic turn-complete and cached-schema equivalent
  outside the server-reported learned Host cutoff handoff window.
- Preserve explicit Host timeout recovery, pre-cutoff handoff, manual priority,
  real external blockers and all-work-complete termination.
- Underfloor quiet is diagnostic only. Never create new ORPHANED or READY state
  from it; retain read/revocation compatibility for historical dev96 rows.
- Preserve pending strict-stop identity drain work, restricting retry kills to
  positive, exact CreationTicks identity matches.
- Restore development version markers. Pause Release/backfill workflows and
  require DEVSPACE_RELEASE_APPROVED=true before either can run again.

## Validation and limits

ATCC, resident, wire and architecture focused regressions passed during this
iteration; wire ACK was 7057 bytes before the final guidance wording refresh.
Guard, full source regression, deployment and real Host acceptance are still
pending at this checkpoint.

The MCP server cannot force a Host model to keep generating or observe private
reasoning. These changes remove concrete early-yield permissions and unsafe
quiet inference; local passing tests alone do not establish live stability.
Final acceptance requires actual long synthetic work and a subsequent
automatic handoff, with generation, delivery, ACK and substantive activity
evidence. Do not classify a handful of polls or background progress as success.
