# Asif Malik MD Portal

Patient and client portal for one-time psychiatric consultations, IMEs and records reviews.
React frontend + one Vercel serverless function + Knack backend ("Asif Malik MD Portal", app ID `6ac2990a22b9402692269ca2`).

## What works now

- **Booking.** Mondays 9, 10 and 11 AM Pacific, booked at least 14 hours ahead, only for patients physically in CA, ID, PA or WA. The chosen slot is held for 15 minutes, then the patient pays.
- **Sign-in.** Through Knack's secure hosted login (OAuth with PKCE). Patients self-register. Firm users register, then wait for approval.
- **Patient dashboard.** Shows the next step, the appointment, ID status, the six-stage report tracker, information holds, paperwork, uploads, the report download, in-portal updates, email preferences and the three structured requests. Available in English and Spanish.
- **Organization dashboard.** Shows the case list, new requests with an automatic quote, payment, holds, paperwork, uploads and report download.
- **Your workspace (Dr. Malik).** Lets you:
  - update the status of a case
  - request missing information (what, who, how)
  - mark a client's upload as reviewed, then clear or keep the hold
  - approve and release a version to the recipients you choose
  - read the full audit trail
  - mark a patient's ID as checked on camera
  - link firm users to their organization
- **Access rules, enforced on the server.** People see only their own cases. Reports go only to named recipients. Downloads stream through the server, with no public links.

A simulated end-to-end test of all of the above passes 31 of 31 checks.

## Test mode (until credentials arrive)

| Service | Without credentials | To go live |
|---|---|---|
| ID.me | "Complete test verification" button | Set `IDME_CLIENT_ID`, `IDME_CLIENT_SECRET`, `IDME_BASE`. Check endpoints marked `VERIFY` in `api/_lib/integrations.js` against ID.me docs |
| Sphere payments | Approve/decline test page | Set Sphere vars and finish `sphere.checkoutUrl` and `sphere.confirm` per Sphere's hosted-page guide (marked `VERIFY`) |
| Daily video | Shows room name only | Set `DAILY_API_KEY` |
| Email | In-portal updates only | Set `RESEND_API_KEY` and verify the sending domain |

**Before launch:** test payments are confirmed by a URL flag, so payments must be configured with real Sphere credentials before any real patient books.

## Deploy

1. Push this folder to a new GitHub repo, then import it in Vercel. Name the project `asifmalikmd-portal` so the registered login address works.
2. In Vercel → Settings → Environment Variables, add everything from `.env.example`. Get `KNACK_API_KEY` from Knack → Settings → API & Code. Never put it in frontend code.
3. Domain: in Vercel add `app.asifmalikmd.com`. In GoDaddy DNS add a CNAME record, `app` → `cname.vercel-dns.com`. Leave the existing website and email records alone.
4. In Knack:
   - Change the app time zone to Pacific, then set `KNACK_APP_TZ=America/Los_Angeles`.
   - Create your own login under the **Providers** role.
   - Approve firm users as they register.
   - Look at the 8 unexplained records in Accounts.

Registered sign-in return addresses: `https://app.asifmalikmd.com/auth/callback`, `https://asifmalikmd-portal.vercel.app/auth/callback`, `https://localhost/auth/callback`.

## Appointment reminders

A daily job runs at 17:00 UTC (10 AM Pacific in summer, 9 AM in winter). It emails patients whose Booked appointment starts in 12–36 hours, unless they turned reminders off. Each appointment is reminded once. The email says only that an appointment is coming up, with a sign-in link. Set `CRON_SECRET` in Vercel. Vercel sends it automatically.

## Public website (asifmalikmd.com)

`website/index.html` is a single self-contained page. Its buttons send people to `app.asifmalikmd.com/book` and `/login`.

1. Create a second Vercel project from the same repo with Root Directory `website` and no build command.
2. Add domains `asifmalikmd.com` and `www.asifmalikmd.com`.
3. In GoDaddy DNS, set the `@` A record to `76.76.21.21` and a `www` CNAME to `cname.vercel-dns.com`. Confirm these values on the Vercel domain screen. Leave MX (email) records unchanged.

**Hosting plan:** Vercel's free Hobby plan is for non-commercial use, so put both projects on Vercel Pro.

## Phone apps (Android and iPhone)

Capacitor wraps the live site (`capacitor.config.json` points to `https://app.asifmalikmd.com`).

```
npm install
npx cap add android && npx cap add ios
npx cap open android   # Android Studio → build signed bundle → Google Play
npx cap open ios       # Xcode on a Mac → archive → App Store Connect
```

Both stores need organization developer accounts (D-U-N-S number). Apple sometimes rejects apps that only wrap a website, so plan to add push notifications for status updates before submitting to Apple.

## Still to do

- Live credentials and final endpoint checks: ID.me, Sphere, Daily, email.
- Virus scanning of uploads. Uploads are recorded as `Scan: Pending` until a scanning step is added.
- Confirm how Knack's hosted sign-up page lets a new user choose between Patient and Organization roles.
- Lemonade charting handoff.
