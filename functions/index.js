const { onSchedule } = require("firebase-functions/v2/scheduler");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, Timestamp } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

initializeApp();
const db = getFirestore();
const messaging = getMessaging();

// Runs every minute; sends a push for any reminder whose time has passed
// and hasn't been notified yet, then marks it notified.
exports.sendDueReminders = onSchedule("every 1 minutes", async () => {
  const now = Timestamp.now();
  const usersSnap = await db.collection("users").get();

  for (const userDoc of usersSnap.docs) {
    const tokens = userDoc.data().fcmTokens || [];
    if (tokens.length === 0) continue;

    const dueSnap = await userDoc.ref
      .collection("reminders")
      .where("notified", "==", false)
      .where("when", "<=", now)
      .get();

    for (const reminderDoc of dueSnap.docs) {
      const { title } = reminderDoc.data();
      try {
        await messaging.sendEachForMulticast({
          tokens,
          notification: { title: "Spoken reminder", body: title },
        });
      } catch (err) {
        console.error("Push send failed for user", userDoc.id, err);
      }
      await reminderDoc.ref.update({ notified: true });
    }
  }
});
