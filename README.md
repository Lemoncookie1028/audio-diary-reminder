# Spoken — voice diary & reminders

A small web app: record voice diary entries (audio only, no transcription),
and set reminders that reach you as browser push notifications even when
the tab is closed. Sign-in is Google only, via Firebase Auth.

`public/index.html` is a static landing page; `public/home.html` is the
actual signed-in app (recorder, entries, reminders). The landing page's
"Open Spoken" button just links to `home.html`.

## Stack

- **Auth:** Firebase Authentication (Google provider)
- **Data:** Firestore (`users/{uid}/entries`, `users/{uid}/reminders`)
- **Audio storage:** the signed-in user's own Google Drive, in a folder
  called "Spoken Voice Diary" that the app creates for itself. It only
  ever has access to files it created (the `drive.file` scope) — never
  the rest of the user's Drive.
- **Push:** Firebase Cloud Messaging + a scheduled Cloud Function (checks
  every minute for due reminders and sends the push)
- **Hosting:** Firebase Hosting (or any static host, minus the Function)

### A note on the Drive approach

Storing audio in Drive means no Firebase Storage bill or quota, and the
recordings live in an account the user already controls. The trade-off:
Drive access uses a separate OAuth token from the Firebase sign-in one,
and it expires roughly every hour. There's no backend here to silently
refresh it, so when a Drive call fails from an expired token, the app
shows a "Reconnect" button that re-asks for Drive permission. Playback
also fetches each recording with that token rather than using a plain
`<audio src="...">` URL, so entries load in a moment rather than being
instantly ready.

## 1. Create the Firebase project

1. Go to [console.firebase.google.com](https://console.firebase.google.com) → **Add project**.
2. Once created, click the **web** icon (`</>`) to register a web app. Copy
   the config object it gives you into `public/firebase-config.js`
   (replace every `YOUR_...` placeholder), and paste the same values into
   `public/firebase-messaging-sw.js`.
3. **Build → Authentication → Get started → Sign-in method** → enable
   **Google**.
4. **Build → Firestore Database → Create database** (production mode is fine —
   `firestore.rules` locks it down).
5. **Project settings → Cloud Messaging → Web configuration → Web Push
   certificates** → click **Generate key pair**. Copy the key into
   `VAPID_KEY` in `public/firebase-config.js`.
6. In the [Google Cloud Console](https://console.cloud.google.com) (same
   project — Firebase projects are Cloud projects), go to **APIs &
   Services → Library** and enable the **Google Drive API**.
7. Under **APIs & Services → OAuth consent screen**, add the
   `.../auth/drive.file` scope, and add the Google account(s) you'll sign
   in with as **test users**. `drive.file` is a narrow, non-sensitive
   scope, so for personal use you can leave the app in "Testing" mode —
   no Google verification review needed — as long as you're on the test
   user list.
8. The scheduled Cloud Function needs the **Blaze (pay-as-you-go) plan**
   (still free at this scale — Cloud Scheduler's free tier covers a
   once-a-minute job). Upgrade under **Project settings → Usage and billing**.

## 2. Install tooling

```bash
npm install -g firebase-tools
firebase login
cd spoken   # this folder
firebase use --add   # pick the project you just created
```

## 3. Deploy

```bash
firebase deploy --only firestore:rules
cd functions && npm install && cd ..
firebase deploy --only functions
firebase deploy --only hosting
```

Firebase Hosting will print your live URL (`https://YOUR_PROJECT_ID.web.app`).
Google Sign-In only works from domains listed under **Authentication →
Settings → Authorized domains** — Hosting's own domain is added
automatically; add any custom domain there too.

## How it works

- **Recording:** uses the browser's `MediaRecorder` API to capture audio,
  uploads the `.webm` file straight to the user's Drive folder, and saves
  a Firestore doc with the title, timestamp, and the Drive file ID.
- **Reminders:** each reminder is a Firestore doc with a title, a due time,
  and a `notified` flag. While the app is open, a timer also fires a local
  notification the moment a reminder comes due, so you don't have to wait
  on the scheduled check.
- **Push, tab closed:** the `sendDueReminders` Cloud Function runs every
  minute, finds reminders whose time has passed and haven't been notified,
  and sends a push to every device token you've granted notification
  permission on. It then marks the reminder `notified: true`.

## Notes / things you may want to change

- Everything is scoped under `users/{yourUid}` in Firestore and Storage —
  each person only ever sees their own entries and reminders.
- There's no recurring-reminder support yet (one-off date/time only) —
  add a `recurrence` field and a bit more logic in the Function if you
  want repeats.
- Every-minute Cloud Scheduler jobs are within Firebase's free Blaze quota
  at low volume; keep an eye on usage if this gets busy.
- No app icon is bundled — drop a `public/icon.png` (used for
  notifications) if you want one.
