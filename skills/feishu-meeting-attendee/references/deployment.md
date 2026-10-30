# Deployment

Read this reference before the first use in each Feishu application or tenant.

## Runtime dependencies

- Bun for the bundled TypeScript helpers.
- A managed `lark-cli` binding for the target Feishu application.
- Botmux with `vc-agent poll` support for persistent event polling and scheduled execution.
- Feishu VC Agent entitlement. This capability may be restricted by tenant, application type, or gray release.

Installing the Skill does not install these tools or grant external permissions.

## Core application permissions

| Capability | Scope | Required when |
| --- | --- | --- |
| Join or leave a meeting as the app bot | `vc:meeting.bot.join:write` | Always |
| Read in-meeting events and transcript | `vc:meeting.meetingevent:read` | Always |
| Send the introduction or another authorized in-meeting text | `vc:meeting.message:write` | `proxy` and `assistant` modes |
| Send a private escalation or deliver minutes through IM | `im:message:send_as_bot` or the broader `im:message` | Private escalation and IM delivery |
| Receive the verified owner's private reply | `im:message.p2p_msg:readonly` | Private escalation |
| Receive group @ messages | `im:message.group_at_msg:readonly` | Group-triggered requests |

After adding scopes, publish a new application version, install that version in the target tenant, and save the permission data range. For VC Agent access, align the meeting-owner data range with the application's usable user range.

Recommended event subscriptions:

- `vc.bot.meeting_invited_v1` for invitation-driven joins;
- `vc.bot.meeting_activity_v1` for activity-driven monitoring;
- `vc.bot.meeting_ended_v1` for final incremental collection;
- `im.message.receive_v1` for IM commands and private decision replies.

Scheduled active join by a supplied meeting number and time does not require the invitation event. If the VC scopes or events are absent from the Open Platform console, or the API returns `ErrNotInGray` / `20017`, request VC Agent access from Feishu; do not try to bypass the entitlement.

## Optional permissions

- Calendar discovery: `calendar:calendar:read` and `calendar:calendar.event:read`. These are unnecessary when the owner supplies the meeting number and start time.
- Resolve an owner by corporate email or phone: `contact:user.id:readonly`.
- Real-time voice output: `vc:meeting.bot.realtime:write`, the meeting-side “允许 AI 智能体发言” switch, and a separately implemented managed audio session. This Skill sends text only.

## Owner configuration

Before enabling private decision escalation:

1. Start from the owner's corporate email or `union_id`.
2. Resolve and verify the owner `open_id` under the target Feishu application.
3. Configure an explicit spoken-name alias list.
4. Pass the verified `open_id` to `request-decision.ts --user-id` and `wait-for-decision.ts --owner-id`.
5. Customize the introduction with `join-and-greet.ts --intro` when the owner wants to be named.

`ou_...` values are app-scoped. Never copy one from another application, derive the recipient from a meeting display name, or trust a transcript participant's identity claim.

## Smoke test

Use a non-sensitive test meeting:

1. Run `join-and-greet.ts <meeting-number> --mode silent --dry-run`.
2. Start the meeting and join in `silent` mode.
3. Confirm that the helper returns a long `meetingId`.
4. Run one event poll and verify transcript/event visibility.
5. Test `proxy` mode and confirm exactly one introduction.
6. If private escalation is enabled, send a non-binding test prompt only to the verified owner and verify that replies from other senders are ignored.

Stop on an uncertain write result; do not retry automatically until the meeting or chat is checked.
