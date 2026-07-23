# Blog Content Agent — Track A Build Spec

**Status:** building — target testable **2026-07-24**
**Repo/branch:** `devreachgiant/giant-app` @ `feature/blog-content-agent`
**Pattern:** mirrors the Vulcan media agent — **frontend wizard + stateless single-shot functions** (the app has no server orchestration; human gates are the pauses).

---

## 1. Goal

A **client-scoped, step-by-step content agent** in the Giant app that turns a *topic (for a chosen client)* into a publish-ready article + images, grounded in that client's brand kit. Not blog-only: a `content_type` field supports `blog | location_page | service_page` (v1 ships `blog` end-to-end; the others are prompt variants of the same pipeline).

Every finished piece is stored per-client in a new `blog_posts` table — which **also becomes the seed corpus for Track B's per-client memory**.

## 2. Non-goals (v1 — explicitly deferred)

- **Real Ahrefs keyword API** — none exists in the app today. v1 uses a Claude-driven keyword/FAQ/intent pass; a clean seam (`enrichWithAhrefs()` no-op) is left for the real integration once a key is provided.
- **Batch "assign 10 topics, auto-run" autonomous mode** (SOP step 1) — v2. Functions are designed to be batch-callable so a runner can loop them later.
- **CMS / direct publish** — v1 exports Markdown / HTML / Google-Doc-ready; publishing stays manual per the SOP.
- **Vector RAG over prior content** — that's Track B. v1 grounds on `brand_kits` + an editable per-client guidelines box + any pasted context.

## 3. UX flow (wizard steps) — mirrors `openVulcanWizard`

1. **Client & Brand** — pick client (reuse `loadBrandKits()` clients-join) → pick/confirm brand kit; shows tone/voice.
2. **Topic & Intent** — topic, `content_type`, target location/service (for those types), optional notes.
3. **Research → Brief** — `blog-research` → `{ search_intent, primary_keyword, secondary/semantic keywords, faqs[], outline (H2/H3), internal_links[], external_links[], meta_title, meta_description }`. Human reviews/edits. **[Gate 1: approve brief]**
4. **Draft** — `blog-draft` writes the article **section-by-section** from the approved outline + brand voice, weaving keywords + links + FAQ. Assembled client-side with live progress.
5. **Images** — `blog-images` reads the draft, picks **1 feature + 3–4 body** spots, brand-matched prompts, generates via Gemini (reuse Vulcan `generateImage`), returns base64 + SEO alt text. Regenerate / skip / add screenshots manually.
6. **Review & Export** — final article + images + meta. **[Gate 2]** copy Markdown / download HTML / Google-Doc-ready; **Save** persists the `blog_posts` row.

**State:** one in-memory `st` object (like Vulcan's `defState()`). Each finished step persists to `blog_posts` (status advances) so nothing is lost on refresh.

## 4. Backend functions (new; stateless; `requireUser` + `_cors`; 26s timeout)

| Function | Input | Output | Notes |
|---|---|---|---|
| `blog-research.js` | `{client, brand_kit, topic, content_type, notes}` | brief JSON | Claude system = SEO content strategist (semantic SEO + intent + FAQ from model knowledge). `enrichWithAhrefs()` = no-op seam in v1. `max_tokens ~2500`. |
| `blog-draft.js` | `{brief, brand_kit, section, prior_sections}` → one section; `{mode:'meta'}` / `{mode:'faq'}` variants | section Markdown / meta / FAQ | Called once per outline section → each call fast (<26s). Frontend loops + assembles. |
| `blog-images.js` | `{article, brand_kit, spot_count}` | `spots[{position, prompt, alt}]` + images | Reuse `planCampaign`-style plan + `generateImage` + `uploadImageToStorage` (existing `vulcan-images` bucket, `blog/` prefix — no new storage setup). |

**Model:** `BLOG_MODEL` constant per function; v1 = `'claude-sonnet-4-5-20250929'` (known-good on the account) → bump to `claude-sonnet-5` once verified against the key. Draft ~1500 max_tokens/section.

## 5. Data model — new migration (client-scoped, RLS-correct)

`blog_posts`: `id, client_id (FK clients NOT NULL), brand_kit_id (FK brand_kits null), created_by, content_type, status, topic, title, meta_title, meta_description, brief jsonb, outline jsonb, keywords jsonb, faqs jsonb, content_md, content_html, images jsonb, links jsonb, published_url, created_at, updated_at`.

**RLS** (avoids the latent OR-with-`USING(true)` leak in the projects policies):
- `blog_posts_staff_all` — `FOR ALL TO authenticated USING (NOT is_client_user()) WITH CHECK (NOT is_client_user())` (internal staff full CRUD).
- `blog_posts_client_read` — `FOR SELECT TO authenticated USING (is_client_user() AND client_id = current_user_client_link())` (client-portal read-only, scoped).

## 6. Dependencies / risks

- `ANTHROPIC_API_KEY` + `GEMINI_API_KEY` already in Netlify (used by Vulcan). ✓
- **Ahrefs:** none → v1 fallback; flag to connect a real provider for volume/difficulty.
- **26s function timeout** → section-by-section drafting (mitigated). netlify.toml sets 26s for `blog-*`.
- **"Trained Claude per client"** (their manual Claude.ai projects) can't be read by automation → we encode the equivalent via `brand_kits.tone/voice_notes` + an editable per-client **content-guidelines** box (persisted for reuse; extend `brand_kits` or a small `blog_client_settings` if needed).

## 7. Test plan (testable tomorrow)

Pick a real client + brand kit → topic → brief renders + editable → approve → draft assembles → images generate → export Markdown + Save → row in `blog_posts` with correct `client_id`; re-open persists. **Isolation check:** a `client`-role user cannot see another client's posts.

## 8. Handoff

Built on `feature/blog-content-agent` (local). **Sam pushes + opens the PR** to `devreachgiant/giant-app` (the auto-mode classifier blocks my push; the other dev is active on `main`).
