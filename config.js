// ============================================================================
// Giant — Configuration
// ============================================================================
window.GIANT_SUPABASE_URL = "https://dqlbeloaoexulxjjxmgb.supabase.co";
window.GIANT_SUPABASE_ANON_KEY = "sb_publishable_1Nz3TrRFjU88yciOmIJhrQ_oWPBgmWg";
// Giphy API key for the chat GIF picker (free at https://developers.giphy.com → Create App → API key).
// Paste your key below to enable GIFs:
window.GIANT_GIPHY_KEY = "8bAdkcborDMRSuCKUTHWnGsakxWRUnCd";

// ── Google sign-in (Gmail and Calendar) ─────────────────────────────────────
// The OAuth CLIENT ID of the Google Cloud project Giant signs in through. Public by
// design -- it is in the sign-in URL -- so it belongs here beside the publishable
// Supabase key. The matching CLIENT SECRET is a real secret and lives only in Netlify
// as GOOGLE_CLIENT_SECRET; it must never appear in this file.
//
// Moving Giant to a different Google project is this one line plus that one Netlify
// variable. It used to be pasted in three places in index.html and three more in the
// functions, which is how a half-finished move happens: the sign-in URL points at the
// new project while the token exchange still names the old one, and Google refuses with
// a mismatch that says nothing about which half is wrong.
//
// Everyone reconnects Gmail and Calendar once after a change here: tokens are issued to
// a client id and are meaningless to a different one.
window.GIANT_GOOGLE_CLIENT_ID = "345496937897-g58n7lgeo90qd8h1rqasn8b8aepbvu75.apps.googleusercontent.com";
