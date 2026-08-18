const admin = require("firebase-admin");
const serviceAccount = require("./leave-application-firebase-adminsdk.json");

// Initialize Firebase Admin
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

// The complete mapping of all 13 teachers
const emailChanges = [
    { oldEmail: "kamrulislam@just.edu.bd", newEmail: "mk.islam@just.edu.bd" },
    { oldEmail: "alamhossain@just.edu.bd", newEmail: "alam@just.edu.bd" },
    { oldEmail: "jamil@cse.just.edu.bd", newEmail: "arm.jamil@just.edu.bd" },
    { oldEmail: "nazmulhossain@just.edu.bd", newEmail: "nazmul.justcse@gmail.com" },
    { oldEmail: "nowshinamin@just.edu.bd", newEmail: "n.amin@just.edu.bd" },
    { oldEmail: "monishankerhalder@just.edu.bd", newEmail: "m.halder@just.edu.bd" },
    { oldEmail: "nasimadnan@just.edu.bd", newEmail: "nasim.adnan@just.edu.bd" },
    { oldEmail: "shahabuddin@just.edu.bd", newEmail: "s.uddin@just.edu.bd" },
    { oldEmail: "shalaudding@just.edu.bd", newEmail: "sks.kabir@just.edu.bd" },
    { oldEmail: "ariful@just.edu.bd", newEmail: "sma.hoque@just.edu.bd" },
    { oldEmail: "yasirarafat@just.edu.bd", newEmail: "y.arafat@just.edu.bd" },
    { oldEmail: "atishkumar@just.edu.bd", newEmail: "ak.kumar@just.edu.bd" },
    { oldEmail: "romanarahman@just.edu.bd", newEmail: "rr.ema@just.edu.bd" }
];

async function updateFirebaseEmails() {
    console.log("Starting Firebase email updates...");
    
    for (const change of emailChanges) {
        try {
            const userRecord = await admin.auth().getUserByEmail(change.oldEmail);
            
            await admin.auth().updateUser(userRecord.uid, {
                email: change.newEmail
            });
            
            console.log(`✅ Success: Changed ${change.oldEmail} to ${change.newEmail}`);
        } catch (error) {
            console.error(`❌ Failed for ${change.oldEmail}:`, error.message);
        }
    }
    console.log("Finished Firebase updates!");
    process.exit();
}

updateFirebaseEmails();