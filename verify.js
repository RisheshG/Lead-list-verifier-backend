const express = require("express");
const multer = require("multer");
const fs = require("fs");
const csv = require("csv-parser");
const { stringify } = require("csv-stringify");
const dns = require("dns");
const net = require("net");
const cors = require("cors");
const path = require("path");
const axios = require("axios");
const admin = require("firebase-admin");
require("dotenv").config();

const serviceAccount = {
  type: process.env.FIREBASE_TYPE,
  project_id: process.env.FIREBASE_PROJECT_ID,
  private_key_id: process.env.FIREBASE_PRIVATE_KEY_ID,
  private_key: process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FIREBASE_CLIENT_EMAIL,
  client_id: process.env.FIREBASE_CLIENT_ID,
  auth_uri: process.env.FIREBASE_AUTH_URI,
  token_uri: process.env.FIREBASE_TOKEN_URI,
  auth_provider_x509_cert_url: process.env.FIREBASE_AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.FIREBASE_CLIENT_CERT_URL,
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
});

const db = admin.firestore();

const app = express();
const PORT = 5001;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use("/public", express.static(path.join(__dirname, "public")));

const upload = multer({ dest: "uploads/" });

let progressData = { progress: 0 };
let clients = [];

// List of known disposable domains
const disposableDomains = new Set([
  "mailinator.com",
  "guerrillamail.com",
  "yopmail.com",
  "10minutemail.com",
]);

// SSE Progress & Credit Update
app.get("/progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");

  clients.push(res);
  res.write(`data: ${JSON.stringify({ progress: progressData.progress })}\n\n`);

  req.on("close", () => {
    clients = clients.filter(client => client !== res);
  });
});

function sendProgressUpdate(progress) {
  progressData.progress = progress;
  clients.forEach(client => client.write(`data: ${JSON.stringify({ progress })}\n\n`));
}

// Authentication Middleware
async function authenticate(req, res, next) {
  const idToken = req.headers.authorization?.split('Bearer ')[1];

  if (!idToken) {
    return res.status(401).json({ error: 'Unauthorized: No token provided.' });
  }

  try {
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    req.user = decodedToken;
    next();
  } catch (error) {
    console.error('Error verifying token:', error);
    res.status(401).json({ error: 'Unauthorized: Invalid token.' });
  }
}

// User Login Endpoint
app.post("/login", async (req, res) => {
  const { email, password } = req.body;

  if (!email || !password) {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  try {
    const user = await admin.auth().getUserByEmail(email);
    const token = await admin.auth().createCustomToken(user.uid);

    res.status(200).json({ message: 'Login successful', token });
  } catch (error) {
    console.error('Error logging in:', error);
    res.status(400).json({ error: 'Invalid email or password.' });
  }
});

app.post("/verify", authenticate, upload.single("file"), async (req, res) => {
  const userId = req.user.uid;

  if (!req.file || !req.body.column) {
    return res.status(400).json({ error: "File or column not provided." });
  }

  const columnName = req.body.column.trim();
  const emails = await readCSV(req.file.path, columnName);

  console.log(`Total Entries in CSV: ${emails.length}`);

  if (emails.length === 0) {
    return res.status(400).json({ error: "No valid emails found in the selected column." });
  }

  const userRef = db.collection("users").doc(userId);
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    return res.status(404).json({ error: "User not found." });
  }

  // Retrieve credits as a string and convert to a number
  const userCredits = parseInt(userDoc.data().credits, 10);

  if (userCredits < emails.length) {
    return res.status(400).json({ error: "Not enough credits!" });
  }

  let validEmails = [];
  let invalidEmails = [];
  let catchAllEmails = [];
  let skippedEmails = 0;

  sendProgressUpdate(0);

  const batchSize = 20;
  let completedCount = 0;

  for (let i = 0; i < emails.length; i += batchSize) {
    const batch = emails.slice(i, i + batchSize);

    const batchResults = await Promise.all(batch.map(async (row) => {
      const email = row[columnName]?.trim();
      if (!email || !email.includes("@")) {
        skippedEmails++;
        console.log(`Skipping invalid email: ${email || "EMPTY"}`);
        return null;
      }

      let status = await verifyEmail(email);

      // Final step: Check social media presence for invalid or catchAll emails
      if (status === "invalid" || status === "catchAll") {
        const socialProfileCheck = await checkSocialProfiles(email);
        if (socialProfileCheck.googleFound || socialProfileCheck.linkedinFound) {
          status = "valid"; // Reclassify as valid if social media presence is found
        }
      }

      completedCount++;
      sendProgressUpdate(Math.round((completedCount / emails.length) * 100));

      return { ...row, status };
    }));

    batchResults.forEach(result => {
      if (!result) return;

      if (result.status === "valid") {
        validEmails.push(result);
      } else if (result.status === "invalid") {
        invalidEmails.push(result);
      } else if (result.status === "catchAll") {
        catchAllEmails.push(result);
      } else {
        invalidEmails.push({ ...result, status: "invalid" });
      }
    });

    // Add a small delay between batches to avoid overwhelming the server
    await new Promise(resolve => setTimeout(resolve, 5000)); // 5-second delay
  }

  console.log(`Verified Emails: ${completedCount}`);
  console.log(`Valid Emails: ${validEmails.length}`);
  console.log(`Invalid Emails: ${invalidEmails.length}`);
  console.log(`Catch-All Emails: ${catchAllEmails.length}`);
  console.log(`Skipped Emails (Invalid Format): ${skippedEmails}`);
  console.log(`Total Processed Emails: ${validEmails.length + invalidEmails.length + catchAllEmails.length}`);

  // Deduct credits
  const newCredits = userCredits - emails.length;

  // Convert credits back to a string before saving to Firestore
  await userRef.update({ credits: newCredits.toString() });

  const validFilename = "valid_emails.csv";
  const invalidFilename = "invalid_emails.csv";
  const catchAllFilename = "catchAll_emails.csv";

  saveToCSV(validEmails, validFilename);
  saveToCSV(invalidEmails, invalidFilename);
  saveToCSV(catchAllEmails, catchAllFilename);

  fs.unlink(req.file.path, err => {
    if (err) console.error("Error deleting uploaded file:", err);
  });

  sendProgressUpdate(100);

  res.json({
    validDownloadLink: validEmails.length ? `/public/${validFilename}` : null,
    invalidDownloadLink: invalidEmails.length ? `/public/${invalidFilename}` : null,
    catchAllDownloadLink: catchAllEmails.length ? `/public/${catchAllFilename}` : null,
    validCount: validEmails.length,
    invalidCount: invalidEmails.length,
    catchAllCount: catchAllEmails.length,
    skippedCount: skippedEmails,
    totalProcessed: validEmails.length + invalidEmails.length + catchAllEmails.length,
    credits: newCredits,
  });
});

// New route for single email verification
app.post("/verify-single", authenticate, async (req, res) => {
  const userId = req.user.uid; // Get user ID from the authenticated request
  const { email } = req.body;

  if (!email || !email.includes("@")) {
    return res.status(400).json({ error: "Invalid email address." });
  }

  const userRef = db.collection("users").doc(userId);
  const userDoc = await userRef.get();

  if (!userDoc.exists) {
    return res.status(404).json({ error: "User not found." });
  }

  // Retrieve credits as a string and convert to a number
  const userCredits = parseInt(userDoc.data().credits, 10);

  if (userCredits < 1) {
    return res.status(400).json({ error: "Not enough credits!" });
  }

  let status = await verifyEmail(email);

  // Final step: Check social media presence for invalid or catchAll emails
  if (status === "invalid" || status === "catchAll") {
    const socialProfileCheck = await checkSocialProfiles(email);
    if (socialProfileCheck.googleFound || socialProfileCheck.linkedinFound) {
      status = "valid"; // Reclassify as valid if social media presence is found
    }
  }

  // Deduct credits
  const newCredits = userCredits - 1;

  // Convert credits back to a string before saving to Firestore
  await userRef.update({ credits: newCredits.toString() });

  res.json({ email, status, credits: newCredits });
});

app.get("/credits/:userId", async (req, res) => {
  try {
    const { userId } = req.params;

    // Fetch the user document from the "users" collection
    const userDoc = await db.collection("users").doc(userId).get();

    if (!userDoc.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    // Retrieve the "credits" field from the user document
    const credits = userDoc.data().credits;

    // Convert credits to a number
    const creditsNumber = parseInt(credits, 10);

    return res.status(200).json({ credits: creditsNumber });
  } catch (error) {
    console.error("Error fetching credits:", error);
    return res.status(500).json({ error: "Internal Server Error" });
  }
});

// Reusable function to verify a single email
async function verifyEmail(email) {
  const domain = email.split("@")[1];

  // Step 1: Validate email syntax (Basic validation)
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return "invalid";
  }

  // Step 2: Check if the domain is disposable
  if (isDisposableDomain(domain)) {
    return "invalid";
  }

  // Step 3: Check if the domain is blacklisted

  // Step 4: Check if the host exists
  const hostExists = await checkHostExists(domain);
  if (!hostExists) {
    return "invalid";
  }

  // Step 5: Check MX records
  let mxRecords = await getMXRecords(domain);
  if (mxRecords.length === 0) {
    // Fallback to A records if no MX records are found
    const aRecords = await getARecords(domain);
    if (aRecords.length === 0) {
      return "invalid";
    }
    mxRecords = aRecords;
  }

  // Step 6: Check SMTP response with rate limiting
  const status = await checkSMTP(email, mxRecords[0]);
  if (status === "invalid") {
    return "invalid";
  }

  // Step 7: Check if the server is catch-all
  const isCatchAll = await detectCatchAllServer(mxRecords[0], domain);
  if (isCatchAll) {
    return "catchAll";
  }

  // Step 8: Check if the user's mailbox is full
  const isMailboxFull = await checkMailboxFull(email, mxRecords[0]);
  if (isMailboxFull) {
    return "invalid";
  }

  return "valid";
}

function isDisposableDomain(domain) {
  return disposableDomains.has(domain);
}

function isBlacklistedDomain(domain) {
  return blacklistedDomains.has(domain);
}

async function checkHostExists(domain) {
  return new Promise((resolve) => {
    dns.resolve(domain, "A", (err, addresses) => {
      resolve(!err && addresses.length > 0);
    });
  });
}

async function getMXRecords(domain) {
  return new Promise((resolve) => {
    dns.resolveMx(domain, (err, addresses) => {
      resolve(err || !addresses.length ? [] : addresses.map((record) => record.exchange));
    });
  });
}

async function getARecords(domain) {
  return new Promise((resolve) => {
    dns.resolve(domain, "A", (err, addresses) => {
      resolve(err || !addresses.length ? [] : addresses);
    });
  });
}

async function checkSMTP(email, mxServer) {
  return new Promise((resolve) => {
    let socket = net.createConnection(25, mxServer);
    let resolved = false;

    socket.setTimeout(5000, () => {
      if (!resolved) resolve("invalid");
      socket.destroy();
    });

    socket.on("connect", () => {
      socket.write(`HELO example.com\r\n`);
      socket.write(`MAIL FROM: <test@example.com>\r\n`);
      socket.write(`RCPT TO: <${email}>\r\n`);
      socket.end();
    });

    socket.on("data", (data) => {
      if (!resolved) {
        const response = data.toString();
        if (response.includes("250")) {
          resolved = true;
          resolve("valid");
        } else if (response.includes("550")) {
          resolved = true;
          resolve("invalid");
        } else {
          resolved = true;
          resolve("invalid");
        }
      }
    });

    socket.on("error", () => {
      if (!resolved) resolve("invalid");
    });

    socket.on("close", () => {
      if (!resolved) resolve("invalid");
    });
  });
}

async function detectCatchAllServer(mxServer, domain) {
  const testEmail = `nonexistent-${Date.now()}@${domain}`;
  return new Promise((resolve) => {
    let socket = net.createConnection(25, mxServer);
    let resolved = false;

    socket.setTimeout(5000, () => {
      if (!resolved) resolve(false);
      socket.destroy();
    });

    socket.on("connect", () => {
      socket.write(`HELO example.com\r\n`);
      socket.write(`MAIL FROM: <test@example.com>\r\n`);
      socket.write(`RCPT TO: <${testEmail}>\r\n`);
      socket.end();
    });

    socket.on("data", (data) => {
      if (!resolved) {
        const response = data.toString();
        if (response.includes("250") || response.includes("252")) {
          resolved = true;
          resolve(true);
        } else {
          resolved = true;
          resolve(false);
        }
      }
    });

    socket.on("error", () => {
      if (!resolved) resolve(false);
    });

    socket.on("close", () => {
      if (!resolved) resolve(false);
    });
  });
}

async function checkMailboxFull(email, mxServer) {
  return new Promise((resolve) => {
    let socket = net.createConnection(25, mxServer);
    let resolved = false;

    socket.setTimeout(5000, () => {
      if (!resolved) resolve(false);
      socket.destroy();
    });

    socket.on("connect", () => {
      socket.write(`HELO example.com\r\n`);
      socket.write(`MAIL FROM: <test@example.com>\r\n`);
      socket.write(`RCPT TO: <${email}>\r\n`);
      socket.end();
    });

    socket.on("data", (data) => {
      if (!resolved) {
        const response = data.toString();
        if (response.includes("452") || response.includes("521")) {
          resolved = true;
          resolve(true);
        } else {
          resolved = true;
          resolve(false);
        }
      }
    });

    socket.on("error", () => {
      if (!resolved) resolve(false);
    });

    socket.on("close", () => {
      if (!resolved) resolve(false);
    });
  });
}

// Function to check social media presence
async function checkSocialProfiles(email) {
  const domain = email.split("@")[1];
  try {
    const googleResults = await axios.get(`https://www.google.com/search?q="${email}"`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    const linkedinResults = await axios.get(`https://www.linkedin.com/search/results/people/?keywords=${email}`, {
      headers: { "User-Agent": "Mozilla/5.0" },
    });

    return {
      googleFound: googleResults.data.includes(email),
      linkedinFound: linkedinResults.data.includes(email),
      domainReputation: domain.includes("gmail") ? "Trusted" : "Unknown",
    };
  } catch (err) {
    return { googleFound: false, linkedinFound: false, domainReputation: "Unknown" };
  }
}

// Function to read CSV while retaining original columns
async function readCSV(filePath, columnName) {
  return new Promise((resolve, reject) => {
    let emails = [];
    let rowCount = 0;
    let missingColumnCount = 0;

    fs.createReadStream(filePath)
      .pipe(csv())
      .on("headers", (headers) => {
        console.log("🔍 CSV Headers Detected:", headers);
        // Trim and match column name
        const matchedColumn = headers.find((h) => h.trim().toLowerCase() === columnName.trim().toLowerCase());
        if (!matchedColumn) {
          console.error(`❌ Column "${columnName}" not found in CSV headers. Available headers:`, headers);
          reject(new Error("Column name mismatch"));
        }
      })
      .on("data", (row) => {
        rowCount++;
        const email = row[columnName]?.trim();
        if (email) {
          emails.push(row);
        } else {
          missingColumnCount++;
          console.warn(`⚠️ Skipping row ${rowCount}: Missing "${columnName}" value.`);
        }
      })
      .on("end", () => {
        console.log(`✅ CSV Read Complete: ${rowCount} total rows processed.`);
        console.log(`📩 Emails Extracted: ${emails.length}`);
        console.log(`🚫 Skipped Rows (Missing "${columnName}"): ${missingColumnCount}`);
        resolve(emails);
      })
      .on("error", (error) => {
        console.error("❌ CSV Parsing Error:", error);
        reject(error);
      });
  });
}

// Function to retrieve MX records
function getMXRecords(domain) {
  return new Promise(resolve => {
    dns.resolveMx(domain, (err, addresses) => {
      resolve(err || !addresses.length ? [] : addresses.map(a => a.exchange));
    });
  });
}

// Function to save CSV with original columns and appended "status"
function saveToCSV(data, filename) {
  if (data.length === 0) return null;

  const publicDir = path.join(__dirname, "public");
  if (!fs.existsSync(publicDir)) {
    fs.mkdirSync(publicDir, { recursive: true });
  }

  const filePath = path.join(publicDir, filename);
  const stringifier = stringify({ header: true });
  const outputStream = fs.createWriteStream(filePath);

  stringifier.pipe(outputStream);
  data.forEach(row => stringifier.write(row));
  stringifier.end();

  return filePath;
}

// SSE Progress & Credit Update
app.get("/progress", (req, res) => {
  res.setHeader("Content-Type", "text/event-stream");
  res.setHeader("Cache-Control", "no-cache");
  res.setHeader("Connection", "keep-alive");
  res.setHeader("Access-Control-Allow-Origin", "*"); // Allow CORS for SSE
  res.flushHeaders(); // Flush the headers to establish the connection

  // Send initial progress
  res.write(`data: ${JSON.stringify({ progress: progressData.progress })}\n\n`);

  // Add the client to the list
  clients.push(res);

  // Send a heartbeat every 15 seconds to keep the connection alive
  const heartbeatInterval = setInterval(() => {
    res.write(': heartbeat\n\n');
  }, 15000);

  // Handle client disconnection
  req.on("close", () => {
    clearInterval(heartbeatInterval);
    clients = clients.filter(client => client !== res);
    res.end();
  });
});

function sendProgressUpdate(progress) {
  progressData.progress = progress;
  clients.forEach(client => {
    client.write(`data: ${JSON.stringify({ progress })}\n\n`);
  });
}

app.listen(PORT, () => console.log(`🚀 Server running on http://localhost:${PORT}`));
