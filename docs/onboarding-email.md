# Onboarding email template

This is the first message a trust-gate cohort customer receives. May personalizes the greeting and sends from her own address. The `{{...}}` placeholders are **literal** — no templating engine processes them. May edits them by hand before sending.

**Subject:** Hive — your AI team for {{companyName}}

---

Hi {{firstName}},

Hive is the AI team I've been building for {{companyName}}-style operations. Out of the box you get a Chief of Staff agent in your Slack who handles email, calendar, scheduling, and learns your business as you go. You can add specialist agents (sales, support, ops) the same way you'd hire someone.

Two commands on a Mac to get started:

```
curl -fsSL https://raw.githubusercontent.com/keepur/hive/main/install/bootstrap.sh | bash
```

Or, if you already have Node 22:

```
npm i -g @keepur/hive && hive init
```

Full walkthrough: https://github.com/keepur/hive/blob/main/docs/getting-started.md

About 20 minutes start to first Slack reply. Text me at {{maysCell}} when you're stuck — happy to walk through it on the phone.

— May
