const admin = require('firebase-admin');
const serviceAccount = require("./email-verifier-2d5bf-firebase-adminsdk-fbsvc-48d6e37317.json");

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: 'https://email-verifier-2d5bf.firebaseio.com' // Replace with your Firebase project's database URL
});

const db = admin.firestore();

module.exports = { admin, db };
