# User Story: Recall.ai Meeting Bot Integration

## Story

As a **business owner using Hive**, I want to **send a notetaker bot to my Zoom meetings via Slack** so that **meetings are automatically transcribed and I can review what was discussed without manual note-taking**.

## Acceptance Criteria

- [ ] Chief-of-staff agent can send a Recall.ai bot to a Zoom meeting given a meeting URL
- [ ] Agent can poll bot status (joining, in-call, recording, done)
- [ ] Agent can retrieve the real-time transcript with speaker labels
- [ ] Agent can list recent bots to check on past meetings
- [ ] Agent can remove a bot from an active meeting
- [ ] Integration is optional — Hive starts normally without `RECALL_API_KEY` configured
- [ ] Bot appears in meetings as "Hive Notetaker" by default (customizable per request)

## Out of Scope

- Webhook-based push notifications (poll-only for now)
- Async transcription (real-time provider only)
- Video/audio recording download
- Google Meet / Teams support (API supports it, but not tested in v1)
- Automatic meeting joining via calendar integration
- Transcript storage/persistence beyond Recall.ai's retention
