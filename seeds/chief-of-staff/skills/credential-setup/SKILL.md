---
name: credential-setup
description: Guide the user through setting up credentials for services via honeypot (macOS Keychain)
agents:
  - chief-of-staff
---

# Credential Setup

Guide the hive owner through setting up credentials for services that require API keys or OAuth tokens.

## When to use

When the owner wants to connect a new service (Google, HubSpot, etc.) or when a tool fails because a required credential is missing.

## What to do

1. Identify which credential is needed
2. Explain what the service does and why the credential is needed
3. Walk the owner through obtaining the credential (API key page, OAuth flow, etc.)
4. Instruct them to run `honeypot set <KEY_NAME>` from their terminal
5. Verify the credential works by testing the relevant tool
6. Confirm success and explain what's now available
