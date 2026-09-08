# Delivery obligations

A delivery obligation records an expectation independently of an agent's cron schedule. Removing a schedule or disabling/removing its producer does not remove an existing expectation.

Enrollment requires two deliberate actions: register a specific deliverable, producer, deadline and delivery/notice destinations; then update that producer's workflow to call the schedule server's deliver_obligation tool for the explicit dueAt key returned by my_delivery_obligations. This feature does not enroll any production deliverable or change prompts.

Use an explicitly selected instance with --instance <id>, --config <path>, or HIVE_HOME. The existing database identity sentinel must match; obligation commands never stamp it.

Example registration file, with fake IDs that must be replaced by operator choices:

{
  "_id": "demo-briefing",
  "deliverable": "Demo complete briefing",
  "producerAgentId": "demo-producer",
  "deadline": { "localTime": "08:00", "weekdays": [1,2,3,4,5], "timezone": "America/Los_Angeles" },
  "destination": { "kind": "slack", "channelId": "C00000001" },
  "noticeDestination": { "kind": "slack", "channelId": "C00000002" },
  "createdBy": "demo-operator"
}

hive obligations register --config /path/to/instance/hive.yaml --file /path/to/definition.json
hive obligations list --instance demo --json
hive obligations show demo-briefing --instance demo --limit 20 --json
hive obligations deactivate demo-briefing --instance demo --reason "Replacement expectation registered"

Registration is idempotent only for an identical immutable definition. To change producer, deadline or recipient, deactivate the old ID and register a new ID. There is no delete/re-enable/resend command. No notice recipient is selected automatically.

Deadlines use the registered IANA timezone. Delivery windows are (previous deadline, deadline], with the first lower bound clamped to registration. No deadline at/before registration is created. A spring clock gap has no occurrence; an autumn fold has two separate UTC occurrence keys. Registration prints upcoming instants with local zone/offset. A late delivery stays attached to its explicit original deadline and does not suppress its missed-deadline notice.

The initial deliverable format is one intentionally complete Slack text post, at most 3,900 characters including engine attribution. The engine does not split, truncate, upload a file, or verify the semantic completeness of linked material. Ordinary Slack posts, hosted Slack MCP output, completed turns and acknowledgements are not proof.

A confirmed delivery requires Slack acknowledgement plus persisted receipt evidence. Delivery receipts are append-only activity history; occurrence checkpoints remain after that history expires. Old acknowledgements remain inspectable with history=expired, without recreating deleted rows. expired_unresolved means the engine cannot prove whether an initial receipt write happened before history retention elapsed.

sending and unknown never mean delivered or notified. Unknown post outcomes are not retried because Slack may already have accepted them. This favors avoiding duplicates and can leave no visible message after an ambiguous crash/timeout. Only documented, verified nonacceptance permits a retry. There is no exactly-once visible-delivery guarantee.

The checker runs independently every 30 seconds and never invokes an agent. A missed-deadline notice says there is no confirmed delivery; it does not assert that Slack definitely received nothing. A late correction is retained without deleting or duplicating the original notice.

Deactivation is prospective: deadlines at/before its cutoff remain due. Later expectations are cancelled. An attempt admitted before the atomic deactivation update may finish and preserve its evidence; a fresh admission after the cutoff is refused. The command reports outstanding attempts. Schedules are unaffected.

Producer discovery uses section=definitions for current keys and section=overdue plus nextCursor for older unresolved keys, including past deadlines of deactivated definitions. Acknowledged/cancelled history and sending/unknown states are non-sendable. list/show are read-only and never materialize a deadline, repair a receipt, or send a notice. JSON dates are UTC. receiptRetentionMs reports the observed timestamp TTL in milliseconds. The heartbeat reports unfinished materialization, evaluation, admission and receipt-recovery work units, including future/cancelled evidence repair. It reports backlog while work remains and becomes unknown when its last successful sweep is older than 120 seconds.
