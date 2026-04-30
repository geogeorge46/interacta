const { initializeApp } = require("firebase-admin/app");
const { getFirestore } = require("firebase-admin/firestore");

initializeApp({ projectId: "demo-test" });
const db = getFirestore();

async function test() {
  const gameRef = db.collection("games").doc("test1234");
  try {
    await db.runTransaction(async (t) => {
      t.set(gameRef, { test: 1 });
      t.set(gameRef.collection("secrets").doc("s1"), { role: "spy" });
    });
    
    await db.runTransaction(async (t) => {
      const snap = await t.get(gameRef.collection("secrets"));
      console.log("Docs in snap:", snap.docs.length);
    });
    console.log("Success!");
  } catch (err) {
    console.error("Error:", err);
  }
}

test();
