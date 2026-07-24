-- Blog Content Agent — data model (Track A).
--
-- A client-scoped store for AI-generated content pieces (blog posts, and later
-- location/service pages). Mirrors the app's existing client_id + RLS convention
-- (clients / brand_kits / projects). This table is ALSO the seed corpus for the
-- platform's per-client memory (Track B): every finished piece becomes retrievable
-- client context.
--
-- RLS note: we intentionally do NOT copy the projects pattern of a blanket
-- `USING (true)` policy sitting alongside a client-scoped one — because permissive
-- policies are OR'd, that combination lets a client-portal user read every row.
-- Instead: internal staff (NOT is_client_user()) get full CRUD; client-portal users
-- (role 'client') get read-only access to their own client's rows.

begin;

-- Per-client content guidelines (tone, audience, internal pages, approved resources,
-- do/don't rules) — the SOP's "client best practices, applied automatically to every
-- piece". Lives on the client so every content run for that client inherits it.
alter table "public"."clients" add column if not exists "content_guidelines" text;

create table if not exists "public"."blog_posts" (
  "id"               uuid primary key default gen_random_uuid(),
  "client_id"        uuid not null references "public"."clients"("id") on delete cascade,
  "brand_kit_id"     uuid references "public"."brand_kits"("id") on delete set null,
  "created_by"       uuid default auth.uid() references "public"."profiles"("id") on delete set null,

  "content_type"     text not null default 'blog'
                       check ("content_type" in ('blog','location_page','service_page')),
  "status"           text not null default 'brief'
                       check ("status" in ('brief','brief_approved','drafting','draft','images','review','published','archived')),

  "topic"            text,
  "title"            text,
  "meta_title"       text,
  "meta_description" text,

  "brief"            jsonb not null default '{}'::jsonb,   -- {search_intent, primary_keyword, ...}
  "outline"          jsonb not null default '[]'::jsonb,   -- [{h2, h3[], key_points[]}]
  "keywords"         jsonb not null default '{}'::jsonb,   -- {primary, secondary[], semantic[]}
  "faqs"             jsonb not null default '[]'::jsonb,   -- [{q, a}]
  "links"            jsonb not null default '{}'::jsonb,   -- {internal[], external[]}
  "images"           jsonb not null default '[]'::jsonb,   -- [{position, url, alt, prompt}]

  "content_md"       text,
  "content_html"     text,
  "published_url"    text,

  "created_at"       timestamptz not null default now(),
  "updated_at"       timestamptz not null default now()
);

create index if not exists "blog_posts_client_id_idx"      on "public"."blog_posts" ("client_id");
create index if not exists "blog_posts_status_idx"         on "public"."blog_posts" ("status");
create index if not exists "blog_posts_client_recent_idx"  on "public"."blog_posts" ("client_id", "created_at" desc);

alter table "public"."blog_posts" enable row level security;

-- Internal staff (owner/manager/inhouse_dev/etc — anyone who is NOT a client-portal user): full CRUD.
create policy "blog_posts_staff_all" on "public"."blog_posts"
  for all to "authenticated"
  using (not "public"."is_client_user"())
  with check (not "public"."is_client_user"());

-- Client-portal users (role 'client'): read-only, and only their own client's posts.
create policy "blog_posts_client_read" on "public"."blog_posts"
  for select to "authenticated"
  using ("public"."is_client_user"() and "client_id" = "public"."current_user_client_link"());

grant all on "public"."blog_posts" to "authenticated";
grant all on "public"."blog_posts" to "service_role";

commit;
