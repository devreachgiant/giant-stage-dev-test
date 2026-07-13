# Giant

Internal ReachGiant app — static frontend + Netlify serverless functions, backed by Supabase.

## Stack

- Static frontend served from `index.html` / `share.html`
- Netlify Functions in [`netlify/functions/`](netlify/functions/) (Stripe, Google Calendar, Zoom, Claude, Gemini, Supabase, etc.)
- Supabase for data/auth

## Local development

1. Install the Netlify CLI:
   ```
   npm install -g netlify-cli
   ```
2. Create a `.env` file in the project root with the variables listed below.
3. Run:
   ```
   netlify dev
   ```
   The app will be served at `http://localhost:8888`.

## Required environment variables

| Variable | Used for |
|---|---|
| `ANTHROPIC_API_KEY` | Claude API calls |
| `GEMINI_API_KEY` | Gemini API calls |
| `GEMINI_TEXT_MODEL` | Gemini model selection |
| `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` | Google Calendar OAuth |
| `RESEND_API_KEY` / `RESEND_FROM` | Transactional email |
| `STRIPE_CLIENT_ID` / `STRIPE_SECRET_KEY` / `STRIPE_WEBHOOK_SECRET` | Stripe Connect & billing |
| `SUPABASE_URL` / `SUPABASE_SERVICE_ROLE_KEY` | Supabase data access |
| `ZOOM_ACCOUNT_ID` / `ZOOM_CLIENT_ID` / `ZOOM_CLIENT_SECRET` | Zoom meeting integration |
| `DEPLOY_URL` / `URL` / `GIANT_PUBLIC_URL` | Set automatically by Netlify in deployed environments |

`.env` is gitignored and must never be committed.

## Deployment

Deployed via Netlify. Function timeouts and redirect/header rules are configured in [`netlify.toml`](netlify.toml).
