// Netlify Function: bookings-api
// Public endpoint for: get_event_type, get_availability, create_booking, get_booking, cancel_booking, reschedule_booking

async function sb(path, method = 'GET', payload = null) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) throw new Error('Supabase env not configured');
  const opts = {
    method,
    headers: {
      'apikey': key,
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      'Prefer': method === 'POST' ? 'return=representation' : (method === 'PATCH' ? 'return=representation' : '')
    }
  };
  if (payload) opts.body = JSON.stringify(payload);
  const res = await fetch(`${url}/rest/v1/${path}`, opts);
  const txt = await res.text();
  let data = null;
  try { data = txt ? JSON.parse(txt) : null; } catch(e) { data = txt; }
  if (!res.ok) {
    const err = new Error((data && data.message) || `Supabase ${res.status}`);
    err.statusCode = res.status; err.detail = data;
    throw err;
  }
  return data;
}

async function refreshGoogleToken(refreshToken) {
  const clientId = process.env.GOOGLE_CLIENT_ID || '821166997756-483v3q5verbk94el54lq05c5m7ppqe99.apps.googleusercontent.com';
  const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
  if (!clientSecret) throw new Error('GOOGLE_CLIENT_SECRET not set');
  const res = await fetch('https://oauth2.googleapis.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      refresh_token: refreshToken, client_id: clientId, client_secret: clientSecret,
      grant_type: 'refresh_token'
    }).toString()
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error_description || data.error || 'Refresh failed');
  return data.access_token;
}

// ── ZOOM (Server-to-Server OAuth) ──────────────────────────────────
// Gets an OAuth access token via Server-to-Server (account_credentials grant).
// Requires env: ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET.
async function getZoomAccessToken() {
  const accountId = process.env.ZOOM_ACCOUNT_ID;
  const clientId = process.env.ZOOM_CLIENT_ID;
  const clientSecret = process.env.ZOOM_CLIENT_SECRET;
  if (!accountId || !clientId || !clientSecret) {
    throw new Error('Zoom env not configured (need ZOOM_ACCOUNT_ID, ZOOM_CLIENT_ID, ZOOM_CLIENT_SECRET)');
  }
  const basic = Buffer.from(`${clientId}:${clientSecret}`).toString('base64');
  const res = await fetch(`https://zoom.us/oauth/token?grant_type=account_credentials&account_id=${encodeURIComponent(accountId)}`, {
    method: 'POST',
    headers: { 'Authorization': `Basic ${basic}` }
  });
  const data = await res.json();
  if (!res.ok) throw new Error(data.reason || data.error || 'Zoom token request failed');
  return data.access_token;
}
// Creates a Zoom meeting for the given host email (or 'me' for the account default user).
// Returns { meetingId, joinUrl, startUrl } on success, or null on failure.
async function createZoomMeeting(booking, evt, guestName, guestEmail, hostEmail) {
  try {
    const accessToken = await getZoomAccessToken();
    const start = new Date(booking.start_at);
    const durationMin = evt.duration_min || 30;
    // Use the host email as the user identifier if provided; otherwise fall back to 'me'
    const userPath = hostEmail ? encodeURIComponent(hostEmail) : 'me';
    const payload = {
      topic: `${evt.name} with ${guestName}`,
      type: 2, // scheduled meeting
      start_time: start.toISOString().replace(/\.\d{3}Z$/, 'Z'),
      duration: durationMin,
      timezone: 'UTC',
      agenda: `Meeting with ${guestName} (${guestEmail})`,
      settings: {
        host_video: true,
        participant_video: true,
        join_before_host: false,
        mute_upon_entry: false,
        waiting_room: false,
        approval_type: 0,
        audio: 'both',
        auto_recording: 'none'
      }
    };
    const res = await fetch(`https://api.zoom.us/v2/users/${userPath}/meetings`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload)
    });
    const data = await res.json();
    if (!res.ok) {
      console.warn('[zoom] create meeting failed:', res.status, data.message || data);
      return null;
    }
    return {
      meetingId: data.id,
      joinUrl: data.join_url,
      startUrl: data.start_url
    };
  } catch(e) {
    console.warn('[zoom] error:', e.message);
    return null;
  }
}

async function createGcalEventWithMeet(hostId, booking, evt, guestName, guestEmail, guestNotes, giantMeetUrl) {
  try {
    const tokens = await sb(`gcal_tokens?profile_id=eq.${hostId}&limit=1`);
    if (!tokens.length) return null;
    let accessToken = tokens[0].access_token;
    const refreshToken = tokens[0].refresh_token;
    const start = new Date(booking.start_at);
    const end = new Date(booking.end_at);
    // Giant Meet only: insert the meet URL into the description + location so the host sees it on their Google Calendar.
    const meetLink = giantMeetUrl || booking.meeting_link;
    // Build attendees list: guest + all invitees
    const attendees = [{ email: guestEmail, displayName: guestName }];
    const invList = Array.isArray(evt.invitees) ? evt.invitees : [];
    for (const inv of invList) {
      if (inv.type === 'email' && inv.email) {
        attendees.push({ email: inv.email });
      } else if (inv.type === 'team' && inv.profile_id) {
        try {
          const tprofile = await sb(`profiles?id=eq.${inv.profile_id}&select=email,full_name&limit=1`);
          if (tprofile.length && tprofile[0].email) attendees.push({ email: tprofile[0].email, displayName: tprofile[0].full_name || tprofile[0].email });
        } catch(e) {}
      }
    }
    const event = {
      summary: `${evt.name} with ${guestName}`,
      description: meetLink
        ? `🎥 Join Giant Meet: ${meetLink}\n\n${guestNotes || ''}`.trim()
        : (guestNotes || ''),
      start: { dateTime: start.toISOString(), timeZone: 'UTC' },
      end: { dateTime: end.toISOString(), timeZone: 'UTC' },
      attendees,
      location: meetLink || undefined
    };
    let res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(event)
    });
    if (res.status === 401 && refreshToken) {
      accessToken = await refreshGoogleToken(refreshToken);
      await sb(`gcal_tokens?profile_id=eq.${hostId}`, 'PATCH', { access_token: accessToken });
      res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events?sendUpdates=all`, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(event)
      });
    }
    if (!res.ok) { console.warn('[gcal] create event failed:', res.status); return null; }
    const created = await res.json();
    return { gcalEventId: created.id, meetLink: giantMeetUrl || null };
  } catch (e) {
    console.warn('[gcal] create event error:', e.message);
    return null;
  }
}

async function cancelGcalEvent(hostId, gcalEventId) {
  try {
    const tokens = await sb(`gcal_tokens?profile_id=eq.${hostId}&limit=1`);
    if (!tokens.length) return;
    let accessToken = tokens[0].access_token;
    const refreshToken = tokens[0].refresh_token;
    let res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${gcalEventId}?sendUpdates=all`, {
      method: 'DELETE', headers: { 'Authorization': `Bearer ${accessToken}` }
    });
    if (res.status === 401 && refreshToken) {
      accessToken = await refreshGoogleToken(refreshToken);
      await sb(`gcal_tokens?profile_id=eq.${hostId}`, 'PATCH', { access_token: accessToken });
      res = await fetch(`https://www.googleapis.com/calendar/v3/calendars/primary/events/${gcalEventId}?sendUpdates=all`, {
        method: 'DELETE', headers: { 'Authorization': `Bearer ${accessToken}` }
      });
    }
  } catch (e) { console.warn('[gcal] cancel error:', e.message); }
}

// ── Add to calendar ─────────────────────────────────────────────────────────
// The confirmation email had the time and the join link and no way to put either into a
// calendar, so the guest either typed it in themselves or forgot. Three routes, because
// people's calendars differ and none of them should have to be explained: a .ics file that
// Apple Calendar and Outlook open natively, and prefilled links for Google and Outlook Web.
const icsStamp = (d) => new Date(d).toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');

function buildIcs(booking, eventType, host, joinUrl) {
  const start = icsStamp(booking.start_at);
  const end = icsStamp(booking.end_at);
  // RFC 5545: CRLF line endings, escaped commas/semicolons, and folding is avoided by
  // keeping lines short rather than implementing it wrongly.
  const esc = (t) => String(t || '').replace(/\\/g, '\\\\').replace(/[,;]/g, m => '\\' + m).replace(/\r?\n/g, '\\n');
  const lines = [
    'BEGIN:VCALENDAR', 'VERSION:2.0', 'PRODID:-//Giant//Bookings//EN', 'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH', 'BEGIN:VEVENT',
    `UID:${booking.id}@giant.reachgiant.com`,
    `DTSTAMP:${icsStamp(Date.now())}`,
    `DTSTART:${start}`, `DTEND:${end}`,
    `SUMMARY:${esc(eventType.name + ' with ' + (host.full_name || host.email || 'Giant'))}`,
    `DESCRIPTION:${esc(joinUrl ? 'Join: ' + joinUrl : (eventType.description || ''))}`,
    joinUrl ? `LOCATION:${esc(joinUrl)}` : `LOCATION:${esc(eventType.location_detail || '')}`,
    'STATUS:CONFIRMED', 'END:VEVENT', 'END:VCALENDAR',
  ];
  return lines.join('\r\n');
}

function calendarLinks(booking, eventType, host, joinUrl) {
  const title = `${eventType.name} with ${host.full_name || host.email || 'Giant'}`;
  const details = joinUrl ? `Join: ${joinUrl}` : (eventType.description || '');
  const s = icsStamp(booking.start_at), e = icsStamp(booking.end_at);
  return {
    google: 'https://calendar.google.com/calendar/render?action=TEMPLATE'
      + `&text=${encodeURIComponent(title)}&dates=${s}/${e}`
      + `&details=${encodeURIComponent(details)}&location=${encodeURIComponent(joinUrl || '')}`,
    outlook: 'https://outlook.live.com/calendar/0/deeplink/compose?path=/calendar/action/compose&rru=addevent'
      + `&subject=${encodeURIComponent(title)}`
      + `&startdt=${encodeURIComponent(new Date(booking.start_at).toISOString())}`
      + `&enddt=${encodeURIComponent(new Date(booking.end_at).toISOString())}`
      + `&body=${encodeURIComponent(details)}&location=${encodeURIComponent(joinUrl || '')}`,
  };
}

async function sendBookingEmail(booking, eventType, host, kind, origin, opts) {
  const apiKey = process.env.RESEND_API_KEY;
  if (!apiKey) { console.warn('[bookings] RESEND_API_KEY not set'); return; }
  opts = opts || {};
  // For 'invitation' kind, override recipient with the invitee
  const recipientEmail = opts.recipient || booking.guest_email;
  const recipientName = opts.recipientName || booking.guest_name;
  const start = new Date(booking.start_at);
  const guestTz = booking.timezone || 'UTC';
  const dateStr = start.toLocaleString('en-US', { weekday: 'long', month: 'long', day: 'numeric', year: 'numeric', timeZone: guestTz });
  const timeStr = start.toLocaleString('en-US', { hour: 'numeric', minute: '2-digit', timeZone: guestTz });
  const hostName = host.full_name || host.email || 'your host';
  let subject, intro, ctaBlock = '';
  const manageUrl = origin ? `${origin}/booking/${booking.cancel_token}` : null;
  if (kind === 'cancellation') {
    // A guest who is told "cancelled" and nothing else has to chase somebody to rebook.
    // When the host declined it, say so, say why if a reason was given, and put the link to
    // pick another time in the same email.
    const rebookUrl = (origin && host.booking_slug) ? `${origin}/book/${host.booking_slug}` : null;
    subject = opts.declinedByHost
      ? `Meeting cancelled: ${eventType.name} with ${hostName}`
      : `Booking cancelled: ${eventType.name} with ${hostName}`;
    intro = opts.declinedByHost
      ? `Unfortunately <strong>${hostName}</strong> can't make the meeting you booked${dateStr ? ` on ${dateStr}` : ''}, so it has been cancelled.`
      : `The meeting with <strong>${hostName}</strong> has been cancelled.`;
    if (opts.reason) {
      intro += `<br><br><span style="color:#444;">Reason given: ${String(opts.reason).replace(/[<>]/g, '')}</span>`;
    }
    if (rebookUrl) {
      ctaBlock = `<div style="margin:18px 0;text-align:center;">
        <a href="${rebookUrl}" style="display:inline-block;background:#D00400;color:#fff;text-decoration:none;padding:12px 22px;border-radius:9px;font-size:14px;font-weight:700;">Pick another time</a>
      </div>`;
    }
  } else if (kind === 'reschedule') {
    subject = `Booking rescheduled: ${eventType.name} with ${hostName}`;
    intro = `The meeting with <strong>${hostName}</strong> has been rescheduled to:`;
    if (manageUrl) ctaBlock = `<div style="margin:18px 0;padding:14px;background:#fff;border:1px solid #eaeaea;border-radius:8px;"><div style="font-size:12px;color:#666;margin-bottom:6px;">Need to make changes?</div><a href="${manageUrl}" style="font-size:13px;color:#D00400;text-decoration:underline;font-weight:600;">Manage this booking</a></div>`;
  } else if (kind === 'invitation') {
    // Invitee email — slightly different phrasing
    subject = `You're invited: ${eventType.name} with ${hostName} & ${booking.guest_name}`;
    intro = `You've been added as an invitee to a meeting between <strong>${hostName}</strong> and <strong>${booking.guest_name}</strong>:`;
  } else {
    subject = `Booking confirmed: ${eventType.name} with ${hostName}`;
    intro = `Your meeting with <strong>${hostName}</strong> is confirmed for:`;
    if (manageUrl) ctaBlock = `<div style="margin:18px 0;padding:14px;background:#fff;border:1px solid #eaeaea;border-radius:8px;"><div style="font-size:12px;color:#666;margin-bottom:6px;">Need to reschedule or cancel?</div><a href="${manageUrl}" style="font-size:13px;color:#D00400;text-decoration:underline;font-weight:600;">Manage this booking</a></div>`;
  }
  const meetingLink = booking.meeting_link;
  const isGiantMeet = meetingLink && meetingLink.includes('/meet/');
  const meetingLabel = isGiantMeet ? 'Join Giant Meet' : (meetingLink && meetingLink.includes('meet.google') ? 'Join Google Meet' : 'Join meeting');
  const calLinks = calendarLinks(booking, eventType, host, meetingLink);
  const headerLabel = kind === 'cancellation' ? 'Booking cancelled' : kind === 'reschedule' ? 'Booking rescheduled' : kind === 'invitation' ? "You're invited" : 'Booking confirmed';
  const html = `
    <div style="font-family:-apple-system,BlinkMacSystemFont,Segoe UI,sans-serif;max-width:520px;margin:0 auto;padding:32px 24px;color:#111;">
      <div style="background:linear-gradient(135deg,#D00400,#F0312E);color:#fff;padding:24px;border-radius:14px;margin-bottom:24px;text-align:center;">
        <h1 style="margin:0;font-size:22px;font-weight:800;letter-spacing:-0.02em;">${headerLabel}</h1>
      </div>
      <p style="font-size:15px;line-height:1.6;">Hi ${recipientName},</p>
      <p style="font-size:15px;line-height:1.6;">${intro}</p>
      ${kind !== 'cancellation' ? `<div style="background:#f5f5f5;border-radius:10px;padding:18px;margin:18px 0;">
        <div style="font-size:16px;font-weight:700;margin-bottom:4px;">${eventType.name}</div>
        <div style="font-size:14px;color:#444;">${dateStr}</div>
        <div style="font-size:14px;color:#444;">${timeStr} (${guestTz}) · ${eventType.duration_min} minutes</div>
        ${meetingLink ? `<div style="font-size:14px;color:#444;margin-top:8px;">🎥 <a href="${meetingLink}" style="color:#D00400;">${meetingLabel}</a></div>` : ''}
        ${eventType.location_detail && !meetingLink ? `<div style="font-size:14px;color:#444;margin-top:6px;">Location: ${eventType.location_detail}</div>` : ''}
      </div>` : ''}
      ${booking.guest_notes ? `<p style="font-size:13px;color:#666;"><b>Notes:</b> ${booking.guest_notes}</p>` : ''}
      ${kind !== 'cancellation' ? `<div style="margin:18px 0;">
        <div style="font-size:12px;color:#666;margin-bottom:8px;font-weight:700;">Add it to your calendar</div>
        <a href="${calLinks.google}" style="display:inline-block;padding:9px 14px;margin:0 6px 6px 0;background:#fff;border:1px solid #dcdcdc;border-radius:8px;color:#111;text-decoration:none;font-size:13px;">Google Calendar</a>
        <a href="${calLinks.outlook}" style="display:inline-block;padding:9px 14px;margin:0 6px 6px 0;background:#fff;border:1px solid #dcdcdc;border-radius:8px;color:#111;text-decoration:none;font-size:13px;">Outlook</a>
        <span style="display:inline-block;padding:9px 14px;margin:0 6px 6px 0;background:#fff;border:1px solid #dcdcdc;border-radius:8px;color:#666;font-size:13px;">Apple Calendar — open the attached invite.ics</span>
      </div>` : ''}
      ${ctaBlock}
      <p style="font-size:11px;color:#999;margin-top:32px;border-top:1px solid #eaeaea;padding-top:16px;">Powered by Giant</p>
    </div>
  `;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        from: process.env.RESEND_FROM || 'Giant <noreply@reachgiant.com>',
        to: [recipientEmail], subject, html,
        // Apple Calendar and desktop Outlook open this directly; a cancellation has
        // nothing to add, so it carries no invite.
        ...(kind !== 'cancellation' ? { attachments: [{
          filename: 'invite.ics',
          content: Buffer.from(buildIcs(booking, eventType, host, meetingLink), 'utf8').toString('base64'),
        }] } : {}),
      })
    });
  } catch (e) { console.warn('[bookings] email failed:', e.message); }
}

// ── Is this slot one the host actually offers? ───────────────────────────────
// create_booking used to check only for CLASHES, and every other rule -- working hours,
// notice period, blackout dates, whether the event type is even switched on -- lived in the
// browser. This endpoint is public and unauthenticated and takes a raw event_type_id, so a
// scripted POST could book 3am on a Sunday, or on an event type the host had turned off,
// and it would be accepted, emailed and written into the host's calendar.
//
// The host's availability is written in the HOST's timezone, so it has to be read in that
// timezone here too -- the same bug the public page had, and the server is the copy that
// decides what is real.
function tzOffsetMs(ts, tz) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false,
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit' })
    .formatToParts(new Date(ts))
    .forEach(x => { if (x.type !== 'literal') p[x.type] = x.value; });
  return Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute, +p.second) - ts;
}
// The instant, described in the host's own calendar and clock.
function wallClockIn(ts, tz) {
  const p = {};
  new Intl.DateTimeFormat('en-US', { timeZone: tz, hour12: false, weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
    .formatToParts(new Date(ts))
    .forEach(x => { if (x.type !== 'literal') p[x.type] = x.value; });
  return {
    dayKey: String(p.weekday || '').slice(0, 3).toLowerCase(),   // mon, tue, ...
    isoDate: `${p.year}-${p.month}-${p.day}`,
    minutes: ((+p.hour) % 24) * 60 + (+p.minute),
  };
}

// Returns null when the slot is fine, or a human sentence explaining why it is not.
function slotRejectionReason(evt, start) {
  if (!(start instanceof Date) || isNaN(start.getTime())) return 'That is not a valid time.';
  if (evt.is_active === false) return 'That meeting type is not taking bookings.';

  const tz = evt.timezone || 'UTC';
  const now = Date.now();
  const noticeMs = Math.max(0, (evt.min_notice_hours || 0)) * 3600000;
  if (start.getTime() < now + noticeMs) {
    return (evt.min_notice_hours || 0) > 0
      ? `That time is too soon — ${evt.min_notice_hours} hours' notice is needed.`
      : 'That time is in the past.';
  }
  const maxDays = evt.max_advance_days || 0;
  if (maxDays > 0 && start.getTime() > now + maxDays * 86400000) {
    return `That is further ahead than this meeting type can be booked (${maxDays} days).`;
  }

  const at = wallClockIn(start.getTime(), tz);
  const blackout = Array.isArray(evt.blackout_dates) ? evt.blackout_dates : [];
  if (blackout.includes(at.isoDate)) return 'That date is not available.';

  const ranges = ((evt.availability || {})[at.dayKey]) || [];
  if (!ranges.length) return 'There are no times available on that day.';

  const duration = evt.duration_min || 30;
  // Inside a published window, AND on the grid that window generates -- otherwise 09:07
  // passes for a 09:00-18:00 day, which is not a slot anybody was ever offered.
  const fits = ranges.some(r => {
    const [s, e] = String(r).split('-');
    if (!s || !e) return false;
    const [sh, sm] = s.split(':').map(Number);
    const [eh, em] = e.split(':').map(Number);
    if ([sh, sm, eh, em].some(n => !Number.isFinite(n))) return false;
    const from = sh * 60 + sm, to = eh * 60 + em;
    if (at.minutes < from || at.minutes + duration > to) return false;
    return (at.minutes - from) % duration === 0;
  });
  if (!fits) return 'That time is outside the hours this meeting type is offered.';
  return null;
}

// Where the request came from, as Netlify's edge already knows it. Display only -- see the
// comment on bookings.guest_geo. Everything here is defensive on purpose: this runs inside
// the booking path, and a booking must never fail because a header was missing, truncated,
// or not valid base64. Absent on localhost, where Netlify injects no geo at all.
function geoFromHeaders(headers) {
  try {
    const h = headers || {};
    const raw = h['x-nf-geo'] || h['X-Nf-Geo'];
    if (raw) {
      const g = JSON.parse(Buffer.from(raw, 'base64').toString('utf8')) || {};
      const out = {
        country: (g.country && g.country.name) || null,
        countryCode: (g.country && g.country.code) || null,
        city: g.city || null,
        region: (g.subdivision && g.subdivision.name) || null,
        timezone: g.timezone || null,
      };
      return Object.values(out).some(v => v) ? out : null;
    }
    // Some edges send only a country code. Worth keeping -- a country is most of the value.
    const cc = h['x-country'] || h['x-nf-client-connection-country'];
    return cc ? { country: null, countryCode: String(cc).toUpperCase(), city: null, region: null, timezone: null } : null;
  } catch (_) { return null; }
}

function rand32() {
  const arr = new Uint8Array(16);
  if (typeof crypto !== 'undefined' && crypto.getRandomValues) crypto.getRandomValues(arr);
  else for (let i = 0; i < 16; i++) arr[i] = Math.floor(Math.random() * 256);
  return Array.from(arr).map(b => b.toString(16).padStart(2,'0')).join('');
}

const { allowOrigin } = require('./_cors');

exports.handler = async (event) => {
  const headers = {
    'Access-Control-Allow-Origin': allowOrigin(event),
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Content-Type': 'application/json'
  };
  if (event.httpMethod === 'OPTIONS') return { statusCode: 200, headers, body: '' };
  if (event.httpMethod !== 'POST') return { statusCode: 405, headers, body: JSON.stringify({ error: 'Method not allowed' }) };

  let body;
  try { body = JSON.parse(event.body); } catch(e) { return { statusCode: 400, headers, body: JSON.stringify({ error: 'Invalid JSON' }) }; }
  const { action, params } = body;
  const origin = event.headers.origin || event.headers.Origin || '';

  try {
    if (action === 'zoom_status') {
      // Returns whether Zoom Server-to-Server credentials are configured server-side.
      // Used by the admin Integrations panel to show "connected" or not.
      const configured = !!(process.env.ZOOM_ACCOUNT_ID && process.env.ZOOM_CLIENT_ID && process.env.ZOOM_CLIENT_SECRET);
      return { statusCode: 200, headers, body: JSON.stringify({ configured }) };
    }

    if (action === 'get_event_type') {
      const { slug, host_slug } = params;
      const profiles = await sb(`profiles?booking_slug=eq.${encodeURIComponent(host_slug)}&select=id,full_name,email,avatar_bg,avatar_fg,avatar_url,booking_slug,title&limit=1`);
      if (!profiles.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Host not found' }) };
      const host = profiles[0];
      const types = await sb(`event_types?profile_id=eq.${host.id}&slug=eq.${encodeURIComponent(slug)}&is_active=eq.true&limit=1`);
      if (!types.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Event type not found' }) };
      return { statusCode: 200, headers, body: JSON.stringify({ event_type: types[0], host }) };
    }

    if (action === 'get_public_page') {
      const { host_slug } = params;
      const profiles = await sb(`profiles?booking_slug=eq.${encodeURIComponent(host_slug)}&select=id,full_name,email,avatar_bg,avatar_fg,avatar_url,booking_slug,title&limit=1`);
      if (!profiles.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Host not found' }) };
      const host = profiles[0];
      const event_types = await sb(`event_types?profile_id=eq.${host.id}&is_active=eq.true&select=*&order=duration_min.asc`);
      return { statusCode: 200, headers, body: JSON.stringify({ host, event_types: event_types || [] }) };
    }

    if (action === 'get_availability') {
      const { event_type_id, date_from, date_to } = params;
      const types = await sb(`event_types?id=eq.${event_type_id}&limit=1`);
      if (!types.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Event type not found' }) };
      const evt = types[0];
      const bufferBefore = (evt.buffer_before_min || 0) * 60000;
      const bufferAfter = (evt.buffer_after_min || 0) * 60000;
      const fromIso = new Date(new Date(date_from).getTime() - bufferAfter).toISOString();
      const toIso = new Date(new Date(date_to).getTime() + bufferBefore).toISOString();
      const events = await sb(`calendar_events?profile_id=eq.${evt.profile_id}&start_at=lt.${toIso}&end_at=gt.${fromIso}&select=start_at,end_at`);
      const bookings = await sb(`bookings?host_profile_id=eq.${evt.profile_id}&start_at=lt.${toIso}&end_at=gt.${fromIso}&status=eq.confirmed&select=start_at,end_at`);
      const busy = [...events, ...bookings].map(b => ({
        start: new Date(new Date(b.start_at).getTime() - bufferAfter).toISOString(),
        end: new Date(new Date(b.end_at).getTime() + bufferBefore).toISOString()
      }));
      return { statusCode: 200, headers, body: JSON.stringify({ event_type: evt, busy }) };
    }

    if (action === 'create_booking') {
      const { event_type_id, start_at, guest_name, guest_email, guest_notes, guest_timezone, questions_answers } = params;
      const types = await sb(`event_types?id=eq.${event_type_id}&limit=1`);
      if (!types.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Event type not found' }) };
      const evt = types[0];
      const start = new Date(start_at);
      // The rules, not just the clashes. 400 rather than 409: a clash means "somebody got
      // there first, pick another", this means "that was never on offer".
      const bad = slotRejectionReason(evt, start);
      if (bad) return { statusCode: 400, headers, body: JSON.stringify({ error: bad }) };
      const end = new Date(start.getTime() + evt.duration_min * 60000);
      const fromIso = start.toISOString();
      const toIso = end.toISOString();
      const bufferBefore = (evt.buffer_before_min || 0) * 60000;
      const bufferAfter = (evt.buffer_after_min || 0) * 60000;
      const conflictFromIso = new Date(start.getTime() - bufferBefore).toISOString();
      const conflictToIso = new Date(end.getTime() + bufferAfter).toISOString();
      const conflicts = await sb(`bookings?host_profile_id=eq.${evt.profile_id}&start_at=lt.${conflictToIso}&end_at=gt.${conflictFromIso}&status=eq.confirmed&limit=1`);
      if (conflicts.length) return { statusCode: 409, headers, body: JSON.stringify({ error: 'Slot no longer available' }) };
      const calConflicts = await sb(`calendar_events?profile_id=eq.${evt.profile_id}&start_at=lt.${conflictToIso}&end_at=gt.${conflictFromIso}&limit=1`);
      if (calConflicts.length) return { statusCode: 409, headers, body: JSON.stringify({ error: 'Slot no longer available' }) };

      const cancelToken = rand32();
      // ── GIANT MEET: generate token + meeting_link for video event types ──
      let giantMeetToken = null;
      let giantMeetUrl = null;
      if (evt.location_type === 'video') {
        // Token format: 3 groups of 3 chars (24 bits) — short, memorable, unguessable
        giantMeetToken = rand32().slice(0,3) + '-' + rand32().slice(0,3) + '-' + rand32().slice(0,3);
        // Canonical domain as the fallback, not the raw deploy URL: this link is sent to
        // the person being met, and often to someone outside the company.
        giantMeetUrl = `${origin || 'https://giant.reachgiant.com'}/meet/${giantMeetToken}`;
      }
      const createdArr = await sb('bookings', 'POST', {
        event_type_id: evt.id,
        host_profile_id: evt.profile_id,
        guest_name, guest_email,
        guest_notes: guest_notes || null,
        questions_answers: questions_answers || {},
        start_at: fromIso, end_at: toIso,
        timezone: guest_timezone || evt.timezone || 'UTC',
        // Recorded, not consulted: the meeting time comes from guest_timezone above, which
        // is the guest's own device and their own choice on the page.
        guest_geo: geoFromHeaders(event.headers),
        meeting_link: giantMeetUrl || (evt.location_type === 'video' ? evt.location_detail : null),
        cancel_token: cancelToken
      });
      const booking = Array.isArray(createdArr) ? createdArr[0] : createdArr;

      // Create the meeting record in our new meetings table
      if (giantMeetToken) {
        try {
          await sb('meetings', 'POST', {
            token: giantMeetToken,
            booking_id: booking.id,
            event_type_id: evt.id,
            host_profile_id: evt.profile_id,
            title: `${evt.name} with ${guest_name}`,
            guest_name,
            guest_email,
            status: 'scheduled',
            scheduled_at: fromIso,
            transcript_enabled: true
          });
        } catch(e) { console.warn('[bookings] meeting record create skipped:', e.message); }
      }

      // Also create a Google Calendar event for the host's calendar — but use Giant Meet URL, not Meet
      let gcalInfo = null;
      if (evt.location_type === 'video') {
        try {
          gcalInfo = await createGcalEventWithMeet(evt.profile_id, booking, evt, guest_name, guest_email, guest_notes, giantMeetUrl);
        } catch(e) { console.warn('[bookings] gcal event skipped:', e.message); }
      }

      try {
        await sb('calendar_events', 'POST', {
          profile_id: evt.profile_id,
          gcal_event_id: gcalInfo?.gcalEventId || null,
          title: `${evt.name} with ${guest_name}`,
          description: guest_notes || null,
          location: evt.location_detail || null,
          start_at: fromIso, end_at: toIso,
          source: 'booking',
          booking_id: booking.id,
          meeting_link: booking.meeting_link,
          attendees: [{ email: guest_email, name: guest_name }]
        });
      } catch(e) { console.warn('[bookings] cal_event create skipped:', e.message); }

      const host = (await sb(`profiles?id=eq.${evt.profile_id}&select=full_name,email&limit=1`))[0];

      // ── INVITEES: resolve team members + collect external emails, send each one a confirmation ──
      const inviteesList = Array.isArray(evt.invitees) ? evt.invitees : [];
      const inviteeEmails = []; // {email, name}
      for (const inv of inviteesList) {
        if (inv.type === 'team' && inv.profile_id) {
          try {
            const teamRows = await sb(`profiles?id=eq.${inv.profile_id}&select=email,full_name&limit=1`);
            if (teamRows.length && teamRows[0].email) {
              inviteeEmails.push({ email: teamRows[0].email, name: teamRows[0].full_name || teamRows[0].email });
            }
          } catch(e) {}
        } else if (inv.type === 'email' && inv.email) {
          inviteeEmails.push({ email: inv.email, name: inv.email });
        }
      }
      // Send invitation email to each invitee (fire-and-forget, parallel)
      for (const i of inviteeEmails) {
        sendBookingEmail(booking, evt, host, 'invitation', origin, { recipient: i.email, recipientName: i.name }).catch((err)=> {
          console.warn('[bookings] invitee email failed:', i.email, err.message);
        });
      }

      sendBookingEmail(booking, evt, host, 'confirmation', origin).catch(()=>{});
      return { statusCode: 200, headers, body: JSON.stringify({ booking, event_type: evt, invitees_notified: inviteeEmails.length }) };
    }

    if (action === 'get_booking') {
      const { token } = params;
      if (!token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Token required' }) };
      const bookings = await sb(`bookings?cancel_token=eq.${encodeURIComponent(token)}&limit=1`);
      if (!bookings.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Booking not found' }) };
      const booking = bookings[0];
      const evtypes = await sb(`event_types?id=eq.${booking.event_type_id}&limit=1`);
      const hosts = await sb(`profiles?id=eq.${booking.host_profile_id}&select=id,full_name,email,avatar_bg,avatar_fg,avatar_url,booking_slug,title&limit=1`);
      return { statusCode: 200, headers, body: JSON.stringify({ booking, event_type: evtypes[0], host: hosts[0] }) };
    }

    if (action === 'cancel_booking') {
      // by_host: the host declined it from the app, rather than the guest cancelling from
      // their own link. Same mechanics either way -- the calendar entry goes, the mirror row
      // goes, the guest is emailed -- so this reuses all of it instead of growing a second
      // path that would drift out of step with this one.
      const { token, reason, by_host } = params;
      if (!token) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Token required' }) };
      const bookings = await sb(`bookings?cancel_token=eq.${encodeURIComponent(token)}&limit=1`);
      if (!bookings.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Booking not found' }) };
      const booking = bookings[0];
      if (booking.status === 'cancelled') return { statusCode: 400, headers, body: JSON.stringify({ error: 'Already cancelled' }) };
      const calEvents = await sb(`calendar_events?booking_id=eq.${booking.id}&limit=1`);
      if (calEvents.length && calEvents[0].gcal_event_id) {
        await cancelGcalEvent(booking.host_profile_id, calEvents[0].gcal_event_id);
      }
      await sb(`calendar_events?booking_id=eq.${booking.id}`, 'DELETE');
      const patch = by_host
        ? { status: 'declined', cancel_reason: reason || null, declined_at: new Date().toISOString(), decline_reason: reason || null }
        : { status: 'cancelled', cancel_reason: reason || null };
      await sb(`bookings?id=eq.${booking.id}`, 'PATCH', patch);
      const evt = (await sb(`event_types?id=eq.${booking.event_type_id}&limit=1`))[0];
      const host = (await sb(`profiles?id=eq.${booking.host_profile_id}&select=full_name,email,booking_slug&limit=1`))[0];
      sendBookingEmail({ ...booking, ...patch }, evt, host, 'cancellation', origin,
        { declinedByHost: !!by_host, reason: reason || null }).catch(()=>{});
      return { statusCode: 200, headers, body: JSON.stringify({ ok: true }) };
    }

    if (action === 'reschedule_booking') {
      const { token, new_start_at } = params;
      if (!token || !new_start_at) return { statusCode: 400, headers, body: JSON.stringify({ error: 'Token and new_start_at required' }) };
      const bookings = await sb(`bookings?cancel_token=eq.${encodeURIComponent(token)}&limit=1`);
      if (!bookings.length) return { statusCode: 404, headers, body: JSON.stringify({ error: 'Booking not found' }) };
      const booking = bookings[0];
      const evt = (await sb(`event_types?id=eq.${booking.event_type_id}&limit=1`))[0];
      const newStart = new Date(new_start_at);
      // Rescheduling is a booking too. Without this, a guest could move a call anywhere --
      // the rules were only ever checked on the way in, and only in the browser.
      const badMove = slotRejectionReason(evt, newStart);
      if (badMove) return { statusCode: 400, headers, body: JSON.stringify({ error: badMove }) };
      const newEnd = new Date(newStart.getTime() + evt.duration_min * 60000);
      const bufferBefore = (evt.buffer_before_min || 0) * 60000;
      const bufferAfter = (evt.buffer_after_min || 0) * 60000;
      const conflictFromIso = new Date(newStart.getTime() - bufferBefore).toISOString();
      const conflictToIso = new Date(newEnd.getTime() + bufferAfter).toISOString();
      const conflicts = await sb(`bookings?host_profile_id=eq.${evt.profile_id}&id=neq.${booking.id}&start_at=lt.${conflictToIso}&end_at=gt.${conflictFromIso}&status=eq.confirmed&limit=1`);
      if (conflicts.length) return { statusCode: 409, headers, body: JSON.stringify({ error: 'Slot no longer available' }) };
      // The host's own calendar counts as busy on the way in, and it has to count here too
      // -- otherwise a reschedule can be dropped straight on top of a real meeting that an
      // initial booking would have refused. Excludes this booking's own mirror row.
      const calClash = await sb(`calendar_events?profile_id=eq.${evt.profile_id}&booking_id=neq.${booking.id}&start_at=lt.${conflictToIso}&end_at=gt.${conflictFromIso}&limit=1`);
      if (calClash.length) return { statusCode: 409, headers, body: JSON.stringify({ error: 'Slot no longer available' }) };
      const calEvents = await sb(`calendar_events?booking_id=eq.${booking.id}&limit=1`);
      if (calEvents.length && calEvents[0].gcal_event_id) {
        await cancelGcalEvent(booking.host_profile_id, calEvents[0].gcal_event_id);
      }
      await sb(`calendar_events?booking_id=eq.${booking.id}`, 'DELETE');
      const updatedArr = await sb(`bookings?id=eq.${booking.id}`, 'PATCH', { start_at: newStart.toISOString(), end_at: newEnd.toISOString(), status: 'confirmed' });
      const updated = Array.isArray(updatedArr) ? updatedArr[0] : updatedArr;
      let gcalInfo = null;
      if (evt.auto_generate_meet !== false && evt.location_type === 'video') {
        gcalInfo = await createGcalEventWithMeet(evt.profile_id, updated, evt, updated.guest_name, updated.guest_email, updated.guest_notes);
        if (gcalInfo && gcalInfo.meetLink) {
          await sb(`bookings?id=eq.${booking.id}`, 'PATCH', { meeting_link: gcalInfo.meetLink });
          updated.meeting_link = gcalInfo.meetLink;
        }
      }
      try {
        await sb('calendar_events', 'POST', {
          profile_id: evt.profile_id,
          gcal_event_id: gcalInfo?.gcalEventId || null,
          title: `${evt.name} with ${updated.guest_name}`,
          start_at: newStart.toISOString(), end_at: newEnd.toISOString(),
          source: 'booking', booking_id: booking.id,
          meeting_link: updated.meeting_link,
          attendees: [{ email: updated.guest_email, name: updated.guest_name }]
        });
      } catch(e) { console.warn('[bookings] cal_event recreate skipped:', e.message); }
      const host = (await sb(`profiles?id=eq.${booking.host_profile_id}&select=full_name,email&limit=1`))[0];
      sendBookingEmail(updated, evt, host, 'reschedule', origin).catch(()=>{});
      return { statusCode: 200, headers, body: JSON.stringify({ booking: updated }) };
    }

    return { statusCode: 400, headers, body: JSON.stringify({ error: 'Unknown action' }) };
  } catch (e) {
    console.error('[bookings-api]', e);
    return { statusCode: e.statusCode || 500, headers, body: JSON.stringify({ error: e.message }) };
  }
};
