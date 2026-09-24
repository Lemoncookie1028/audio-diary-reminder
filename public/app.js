import { firebaseConfig, VAPID_KEY } from "./firebase-config.js";

import { initializeApp } from "https://www.gstatic.com/firebasejs/10.13.0/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithRedirect, getRedirectResult, signOut, onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, deleteDoc, onSnapshot,
  query, orderBy, serverTimestamp, Timestamp, setDoc, getDoc, arrayUnion,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-firestore.js";
import {
  getMessaging, getToken, onMessage, isSupported,
} from "https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging.js";

const app = initializeApp(firebaseConfig);
const auth = getAuth(app);
const db = getFirestore(app);

const $ = (id) => document.getElementById(id);
const gate = $("gate"), appEl = $("app");
const signInBtn = $("signInBtn"), signOutBtn = $("signOutBtn"), authError = $("authError");
const userNameEl = $("userName");

let currentUser = null;
let unsubEntries = null, unsubReminders = null;

// ---------- Google Drive (audio storage) ----------
// drive.file only ever lets this app see files it created itself — never
// the rest of the user's Drive.
const DRIVE_SCOPE = "https://www.googleapis.com/auth/drive.file";
const DRIVE_FOLDER_NAME = "Spoken Voice Diary";
let driveAccessToken = sessionStorage.getItem("driveAccessToken") || null;
let driveFolderId = null;

function driveProvider() {
  const provider = new GoogleAuthProvider();
  provider.addScope(DRIVE_SCOPE);
  return provider;
}

function storeDriveToken(token) {
  driveAccessToken = token || null;
  if (token) sessionStorage.setItem("driveAccessToken", token);
  else sessionStorage.removeItem("driveAccessToken");
}

function showDriveNudge(show) { $("driveNudge").hidden = !show; }

// Every Drive call goes through here so an expired token surfaces the
// same "reconnect" prompt in one place, instead of failing silently.
async function driveFetch(url, options = {}) {
  if (!driveAccessToken) {
    showDriveNudge(true);
    throw new Error("Connect Google Drive first.");
  }
  const res = await fetch(url, {
    ...options,
    headers: { ...(options.headers || {}), Authorization: `Bearer ${driveAccessToken}` },
  });
  if (res.status === 401) {
    storeDriveToken(null);
    showDriveNudge(true);
    throw new Error("Your Drive session expired — reconnect and try again.");
  }
  return res;
}

async function ensureDriveFolder(uid) {
  if (driveFolderId) return driveFolderId;

  const userDoc = await getDoc(doc(db, "users", uid));
  const savedId = userDoc.exists() ? userDoc.data().driveFolderId : null;
  if (savedId) { driveFolderId = savedId; return savedId; }

  const q = encodeURIComponent(
    `mimeType='application/vnd.google-apps.folder' and name='${DRIVE_FOLDER_NAME}' and trashed=false`
  );
  const searchRes = await driveFetch(`https://www.googleapis.com/drive/v3/files?q=${q}&fields=files(id)`);
  const searchData = await searchRes.json();
  let folderId = searchData.files?.[0]?.id;

  if (!folderId) {
    const createRes = await driveFetch("https://www.googleapis.com/drive/v3/files?fields=id", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: DRIVE_FOLDER_NAME, mimeType: "application/vnd.google-apps.folder" }),
    });
    const createData = await createRes.json();
    folderId = createData.id;
  }

  driveFolderId = folderId;
  await setDoc(doc(db, "users", uid), { driveFolderId: folderId }, { merge: true });
  return folderId;
}

async function uploadToDrive(uid, blob, title) {
  const folderId = await ensureDriveFolder(uid);
  const metadata = { name: `${title || "entry"}-${Date.now()}.webm`, parents: [folderId] };
  const form = new FormData();
  form.append("metadata", new Blob([JSON.stringify(metadata)], { type: "application/json" }));
  form.append("file", blob);
  const res = await driveFetch("https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart&fields=id", {
    method: "POST",
    body: form,
  });
  if (!res.ok) throw new Error("Drive upload failed.");
  const data = await res.json();
  return data.id;
}

async function deleteFromDrive(fileId) {
  await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}`, { method: "DELETE" });
}

$("reconnectDrive").addEventListener("click", () => {
  signInWithRedirect(auth, driveProvider());
});

// ---------- Auth ----------
signInBtn.addEventListener("click", () => {
  authError.hidden = true;
  signInWithRedirect(auth, driveProvider());
});

// Runs once on load, after either a fresh sign-in or a Drive reconnect
// sends the browser back from Google. Redirect results don't come
// through onAuthStateChanged — they have to be picked up here.
getRedirectResult(auth)
  .then((result) => {
    if (!result) return;
    const credential = GoogleAuthProvider.credentialFromResult(result);
    storeDriveToken(credential?.accessToken);
    showDriveNudge(!driveAccessToken);
  })
  .catch((err) => {
    authError.textContent = "Couldn't sign in — " + err.message;
    authError.hidden = false;
  });

signOutBtn.addEventListener("click", () => {
  storeDriveToken(null);
  driveFolderId = null;
  signOut(auth);
});

onAuthStateChanged(auth, (user) => {
  currentUser = user;
  if (unsubEntries) unsubEntries();
  if (unsubReminders) unsubReminders();

  if (user) {
    gate.hidden = true;
    appEl.hidden = false;
    userNameEl.textContent = user.displayName || user.email || "";
    showDriveNudge(!driveAccessToken);
    watchEntries(user.uid);
    watchReminders(user.uid);
    setupNotifications(user.uid);
  } else {
    gate.hidden = false;
    appEl.hidden = true;
  }
});

// ---------- Tabs ----------
document.querySelectorAll(".tab").forEach((tab) => {
  tab.addEventListener("click", () => {
    document.querySelectorAll(".tab").forEach((t) => { t.classList.remove("active"); t.setAttribute("aria-selected", "false"); });
    document.querySelectorAll(".panel").forEach((p) => p.classList.remove("active"));
    tab.classList.add("active");
    tab.setAttribute("aria-selected", "true");
    $("panel-" + tab.dataset.tab).classList.add("active");
  });
});

// ---------- Recording ----------
const recordBtn = $("recordBtn"), recordLabel = $("recordLabel"), recordTime = $("recordTime");
const entryComposer = $("entryComposer"), previewAudio = $("previewAudio"), entryTitle = $("entryTitle");

let mediaRecorder = null, chunks = [], recordedBlob = null, timerInterval = null, seconds = 0;

recordBtn.addEventListener("click", async () => {
  if (mediaRecorder && mediaRecorder.state === "recording") {
    mediaRecorder.stop();
    return;
  }
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    chunks = [];
    mediaRecorder = new MediaRecorder(stream);
    mediaRecorder.ondataavailable = (e) => chunks.push(e.data);
    mediaRecorder.onstop = () => {
      stream.getTracks().forEach((t) => t.stop());
      recordedBlob = new Blob(chunks, { type: "audio/webm" });
      previewAudio.src = URL.createObjectURL(recordedBlob);
      entryComposer.hidden = false;
      resetRecordUI();
    };
    mediaRecorder.start();
    recordBtn.classList.add("recording");
    recordLabel.textContent = "Tap to stop";
    recordTime.hidden = false;
    seconds = 0;
    updateTimer();
    timerInterval = setInterval(updateTimer, 1000);
  } catch (err) {
    recordLabel.textContent = "Microphone access denied";
  }
});

function updateTimer() {
  const m = String(Math.floor(seconds / 60)).padStart(2, "0");
  const s = String(seconds % 60).padStart(2, "0");
  recordTime.textContent = `${m}:${s}`;
  seconds++;
}

function resetRecordUI() {
  clearInterval(timerInterval);
  recordBtn.classList.remove("recording");
  recordLabel.textContent = "Tap to record";
  recordTime.hidden = true;
}

$("discardEntry").addEventListener("click", () => {
  recordedBlob = null;
  entryTitle.value = "";
  entryComposer.hidden = true;
});

$("saveEntry").addEventListener("click", async () => {
  if (!recordedBlob || !currentUser) return;
  const saveBtn = $("saveEntry");
  saveBtn.disabled = true;
  saveBtn.textContent = "Saving…";
  try {
    const title = entryTitle.value.trim() || "Untitled entry";
    const driveFileId = await uploadToDrive(currentUser.uid, recordedBlob, title);
    await addDoc(collection(db, "users", currentUser.uid, "entries"), {
      title,
      driveFileId,
      createdAt: serverTimestamp(),
    });
    recordedBlob = null;
    entryTitle.value = "";
    entryComposer.hidden = true;
  } catch (err) {
    alert("Couldn't save entry — " + err.message);
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = "Save entry";
  }
});

// ---------- Diary list ----------
function watchEntries(uid) {
  const q = query(collection(db, "users", uid, "entries"), orderBy("createdAt", "desc"));
  unsubEntries = onSnapshot(q, (snap) => {
    const list = $("entryList");
    list.innerHTML = "";
    $("entryEmpty").hidden = snap.size > 0;
    snap.forEach((docSnap) => {
      const e = docSnap.data();
      const card = document.createElement("div");
      card.className = "entry-card";
      const when = e.createdAt ? e.createdAt.toDate().toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "";
      card.innerHTML = `
        <div class="entry-card-head">
          <span class="entry-title"></span>
          <span class="entry-date">${when}</span>
        </div>
        <div class="audio-slot"><button class="btn-ghost play-btn">▶ Play</button></div>
        <div class="card-actions"><button class="icon-btn" data-id="${docSnap.id}" data-file="${e.driveFileId}">Delete</button></div>
      `;
      card.querySelector(".entry-title").textContent = e.title;
      card.querySelector(".play-btn").addEventListener("click", (ev) => playEntry(e.driveFileId, ev.target));
      card.querySelector(".icon-btn").addEventListener("click", async (ev) => {
        const { id, file } = ev.target.dataset;
        if (!confirm("Delete this entry?")) return;
        await deleteDoc(doc(db, "users", uid, "entries", id));
        try { await deleteFromDrive(file); } catch (_) {}
      });
      list.appendChild(card);
    });
  });
}

async function playEntry(fileId, btn) {
  btn.disabled = true;
  btn.textContent = "Loading…";
  try {
    const res = await driveFetch(`https://www.googleapis.com/drive/v3/files/${fileId}?alt=media`);
    if (!res.ok) throw new Error("Couldn't load this recording.");
    const blob = await res.blob();
    const audio = document.createElement("audio");
    audio.controls = true;
    audio.autoplay = true;
    audio.src = URL.createObjectURL(blob);
    btn.replaceWith(audio);
  } catch (err) {
    btn.disabled = false;
    btn.textContent = "▶ Play";
    alert(err.message);
  }
}

// ---------- Reminders ----------
$("reminderForm").addEventListener("submit", async (e) => {
  e.preventDefault();
  if (!currentUser) return;
  const title = $("reminderTitle").value.trim();
  const when = $("reminderWhen").value;
  if (!title || !when) return;
  await addDoc(collection(db, "users", currentUser.uid, "reminders"), {
    title,
    when: Timestamp.fromDate(new Date(when)),
    notified: false,
    createdAt: serverTimestamp(),
  });
  $("reminderForm").reset();
});

function watchReminders(uid) {
  const q = query(collection(db, "users", uid, "reminders"), orderBy("when", "asc"));
  unsubReminders = onSnapshot(q, (snap) => {
    const list = $("reminderList");
    list.innerHTML = "";
    $("reminderEmpty").hidden = snap.size > 0;
    const now = Date.now();
    snap.forEach((docSnap) => {
      const r = docSnap.data();
      const whenDate = r.when.toDate();
      const isPast = whenDate.getTime() < now;
      const card = document.createElement("div");
      card.className = "reminder-card" + (isPast ? " past" : "");
      card.innerHTML = `
        <div class="reminder-card-head">
          <span class="reminder-title"></span>
          <span class="reminder-when">${whenDate.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}</span>
        </div>
        <div class="card-actions"><button class="icon-btn" data-id="${docSnap.id}">Delete</button></div>
      `;
      card.querySelector(".reminder-title").textContent = r.title;
      card.querySelector(".icon-btn").addEventListener("click", () => deleteDoc(doc(db, "users", uid, "reminders", docSnap.id)));
      list.appendChild(card);

      // Catch reminders that came due while this tab is open.
      if (!isPast) {
        const delay = whenDate.getTime() - now;
        if (delay < 24 * 60 * 60 * 1000) {
          setTimeout(() => notifyLocally(r.title), delay);
        }
      }
    });
  });
}

function notifyLocally(title) {
  if (Notification.permission === "granted") {
    new Notification("Spoken reminder", { body: title, icon: "/icon.png" });
  }
}

// ---------- Push notifications ----------
async function setupNotifications(uid) {
  if (!(await isSupported().catch(() => false))) return;
  const nudge = $("notifNudge");

  if (Notification.permission === "granted") {
    await registerForPush(uid);
  } else if (Notification.permission !== "denied") {
    nudge.hidden = false;
  }

  $("enableNotifs").addEventListener("click", async () => {
    const perm = await Notification.requestPermission();
    if (perm === "granted") {
      nudge.hidden = true;
      await registerForPush(uid);
    }
  });
}

async function registerForPush(uid) {
  try {
    const registration = await navigator.serviceWorker.register("/firebase-messaging-sw.js");
    const messaging = getMessaging(app);
    const token = await getToken(messaging, { vapidKey: VAPID_KEY, serviceWorkerRegistration: registration });
    if (token) {
      await setDoc(doc(db, "users", uid), { fcmTokens: arrayUnion(token) }, { merge: true });
    }
    onMessage(messaging, (payload) => {
      const { title, body } = payload.notification || {};
      new Notification(title || "Spoken reminder", { body });
    });
  } catch (err) {
    console.warn("Push setup failed:", err.message);
  }
}
