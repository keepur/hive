# User Story: HubSpot CRM Write Integration

## Story

As a **Dodi agent** (Rae, Jessica, or SDR),
I want to **create and update contacts, deals, notes, and tasks directly in HubSpot**,
So that **CRM data stays current without manual data entry, and all agent actions are logged in the system of record**.

## Acceptance Criteria

1. Agents can look up a contact by email or name before creating (dedup)
2. Agents can create new contacts with standard properties (name, email, phone, company)
3. Agents can create deals with pipeline, stage, amount, and close date
4. Agents can add notes to contacts and/or deals
5. Agents can create and update tasks (status, priority, due date)
6. Agents can associate any two CRM objects (contact↔deal, note↔contact, etc.)
7. All operations return the HubSpot object ID for chaining
8. Rate limiting prevents hitting HubSpot's 100 req/10s limit
9. Transient errors (429, 502, 503) are retried automatically
10. The server is gated on `HUBSPOT_API_KEY` — if not set, server is not registered

## Out of Scope

- Bulk/batch operations (create 100 contacts at once)
- Deleting CRM objects
- Custom object types
- Workflow triggers or automation
- Bidirectional sync (that's the nightly extraction pipeline's job)
