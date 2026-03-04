# User Story: Real-Time Meeting Participation

## Story

As a **business owner using Hive**, I want my **AI agents to join meetings as active participants** so that they can **follow the discussion in real-time, contribute relevant information via chat, and produce a summary when the meeting ends**.

## Acceptance Criteria

- [ ] Agent can join a meeting with `recall_join_meeting` and receive periodic transcript updates
- [ ] Transcript updates are dispatched as WorkItems to the originating agent/thread
- [ ] Agent can send chat messages into the meeting with `recall_send_chat`
- [ ] Chat messages appear for all meeting participants
- [ ] Agent only chimes in when it has relevant input (not on every update)
- [ ] Agent responds "No response needed." for updates with nothing to contribute (suppressed by dispatcher)
- [ ] MeetingMonitor auto-detects meeting end and dispatches final summary prompt
- [ ] Agent produces summary with decisions, action items, and follow-ups when meeting ends
- [ ] MeetingMonitor service starts/stops cleanly with Hive lifecycle
- [ ] Integration is optional — Hive starts normally without `RECALL_API_KEY`
- [ ] Existing `recall_create_bot` still works for passive recording

## Out of Scope

- Webhook-based real-time transcript (polling-only for v1)
- Voice/audio participation (chat-only)
- Persistence of monitoring state across Hive restarts
- Automatic meeting joining via calendar integration
- Multi-platform testing (Zoom only for v1)
