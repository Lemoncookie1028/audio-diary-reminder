importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.13.0/firebase-messaging-compat.js");

// Kept in sync manually with firebase-config.js (service workers can't use ES module imports here).
firebase.initializeApp({
  apiKey: "AIzaSyBNlkxYq_KC-Ovt_7MYSotvHmhV7mx7_uA",
  authDomain: "itisnowad.firebaseapp.com",
  projectId: "itisnowad",
  storageBucket: "itisnowad.firebasestorage.app",
  messagingSenderId: "76440837889",
  appId: "1:76440837889:web:1db2931374d734a7e7c500",
});

const messaging = firebase.messaging();

messaging.onBackgroundMessage((payload) => {
  const { title, body } = payload.notification || {};
  self.registration.showNotification(title || "Spoken reminder", {
    body,
    icon: "/icon.png",
  });
});
