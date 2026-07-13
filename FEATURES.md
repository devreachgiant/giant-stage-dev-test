# Giant — Feature List

## Core workspace
- **Daily Focus** — personal task/priority view for the day
- **Team Pulse** — team activity/status overview
- **Projects** — configurable task table. Master projects with subprojects, per-project custom columns (`project_fields`) and custom priority sets (`project_priorities`), drag-and-drop reordering, multi-assignee, client linking
- **Clients** — client records and team membership
- **Templates** — reusable task/content templates
- **Files** — file storage/management
- **Notes** — note-taking
- **Inbox** — email (Gmail OAuth), email templates and signatures
- **Calendar** — Google Calendar integration, automatic token refresh
- **Meetings** — scheduling plus AI transcription: recordings are transcribed, summarized, and have action items extracted automatically (Gemini)
- **Record** — voice/screen recording, AI dictation (mic → text via Gemini)
- **Chat & Huddles** — team messaging (channels, reactions, attachments) and huddles (calls)

## Magnus — AI agent crew
Multi-agent system that plans and executes marketing work end-to-end.

- **Magnus** (Crew Lead) — reads a client brief, decomposes it into tasks, assigns each to the right specialist
- **Hercules** (Research & SEO Analyst) — market/competitor research, SEO audits, keyword maps, URL and GEO audits
- **Atlas** (Copywriter) — hero copy, meta descriptions, email sequences, ad copy, brand voice docs
- **Titan** (Content Strategist / Editor-in-Chief) — long-form content, editorial plans
- **Jupiter** (Google Ads Specialist) — account audits, wasted spend, campaign plans, negative keywords, bid strategy
- **Vulcan** (Designer / Visual Producer):
  - Generates social media images (Claude for concept + Gemini "Nano Banana Pro" for image gen)
  - Edits existing images from a text instruction
  - Generates video (Veo 3) from an image + concept
  - Parses brand books (PDF) into a brand kit
  - Auto-extracts a brand kit from any URL
  - Revises posts based on client feedback
  - Standalone workflows: social pack, OG card, diagram, brand pack
- Magnus synthesizes specialist outputs into a client-ready summary and routes follow-up chat messages to the right action

## Reach AI
General AI chat/assistant surface backed by the Claude API proxy.

## Client-facing / sharing
- **Share Packs** — public shareable link of deliverables for client review, with anonymous feedback and view tracking
- **Bookings** — public booking pages (embeddable in iframes), availability, create/cancel/reschedule
- **Invitations** — invite team/clients via email (Resend)

## Billing
- **Stripe integration** — OAuth connect flow, invoicing, webhook-driven status updates

## Platform
- **Web app** — served via Netlify, backed by Supabase
- **Desktop app** (Mac / Windows / Linux) — Electron wrapper of the same web app, with native camera/mic/screen-recording permissions, auto-update check

## Infrastructure
- **`devreachgiant/giant-app`** — web app + Netlify functions, git-based continuous deployment, branch-protected `main`
- **`devreachgiant/giant`** — Electron desktop app, branch-protected `main`
- **Supabase** — Postgres database, auth, storage; schema managed via CLI migrations (see `supabase/migrations/`)
