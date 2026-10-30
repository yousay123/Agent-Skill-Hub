# Modes and outputs

Read this reference only when the request needs pre-reading, assistant-mode questions, customized reporting, or Feishu task creation.

## Pre-meeting briefing

Use only sources the verified owner supplies or the current trusted conversation can access. Prefer document body over title/metadata. Keep the briefing private unless the verified owner asks to share it.

Capture:

- meeting objective and the owner's desired outcome;
- agenda and relevant background;
- decisions already made versus questions still open;
- names, product terms, metrics, and dates likely to appear;
- sensitive or approval topics the assistant must not decide for the owner.

If a source cannot be read, state the gap. Do not delay an active meeting solely to finish background research.

## Participation modes

### silent

Join and monitor. Do not send the introduction or clarification questions. Use when the owner wants unobtrusive note-taking.

### proxy

Default. Send the configured introduction once, then monitor. Do not answer substantive questions for the owner or make commitments.

### assistant

Send the introduction and allow clarification questions. Ask no more than three unless the owner explicitly changes the limit. A question is appropriate only when it materially improves the record, such as:

- a stated action lacks an owner;
- an agreed action lacks a deadline;
- two alternatives remain ambiguous at the point a decision is being closed;
- a key term or number is unclear enough to change the conclusion.

Do not interrupt for minor transcription uncertainty, repeat a question already answered, expose private briefing material, approve anything for the owner, or make schedule/cost/production/data commitments. Use `scripts/send-message.ts` with a stable semantic `--key`. If delivery fails or is uncertain, do not retry automatically.

## Live evidence ledger

Maintain these working sets while polling:

- `decisions`: decision text, speaker/time evidence, confidence;
- `todos`: action, owner, due date, status, evidence;
- `questions`: open/answered questions and their evidence;
- `risks`: dependency, impact, mitigation if stated;
- `coverage`: join time, first/last captured event, disconnects, non-final transcripts.

Treat transcript revisions with the same `sentenceId` as one evolving sentence. Chat messages sent by this bot are attendance metadata, not meeting decisions.

## Reporting and task creation

The default deliverable is a structured task draft in the invoking conversation. Do not create external tasks merely because a TODO was detected.

When the verified owner explicitly asks to create tasks for this meeting:

1. Show the proposed title, description, assignee, and due date. Missing assignee or due date remains `待明确`; do not guess.
2. Use the human identity for human-owned Feishu tasks: `lark-cli task +create --as user`. Do not fall back to `--as bot` after a user-identity write failure.
3. Use a stable `--idempotency-key` derived from meeting ID plus the normalized action, so retries cannot duplicate tasks.
4. Stop on an uncertain write result and report it; do not retry until the existing task is checked.

If the current user identity is not authorized for `lark-cli`, request the required user authorization through the host runtime's normal authorization flow, then wait for verified confirmation before retrying. Never replace a missing human authorization with bot identity.

Useful command shape after explicit approval:

```bash
lark-cli task +create --as user --summary '<title>' --description '<meeting evidence and context>' --assignee '<ou_xxx>' --due '<ISO date>' --idempotency-key '<stable-key>' --json
```

If the task owner cannot be resolved to a verified `open_id`, return the draft instead of assigning by display name.
