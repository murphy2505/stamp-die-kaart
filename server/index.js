const express = require("express");
const fs = require("fs").promises;
const path = require("path");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");

const DB_PATH = path.join(__dirname, "db.json");
const PORT = process.env.PORT || 3000;

const app = express();
app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: false }));
// serve static frontend (public/) op / en /public
app.use("/public", express.static(path.join(__dirname, "..", "public")));
app.use("/", express.static(path.join(__dirname, "..", "public")));

/* eenvoudige write-queue om race-conditions bij schrijven naar db.json te voorkomen */
let dbLock = Promise.resolve();

async function readDB() {
  try {
    const raw = await fs.readFile(DB_PATH, "utf8");
    return JSON.parse(raw);
  } catch (err) {
    // init lege structuur als bestand ontbreekt of corrupt is
    return {
      customers: [],
      stamps: [],
      redemptions: [],
      logs: [],
      apiKeys: []
    };
  }
}

async function writeDB(data) {
  dbLock = dbLock.then(() => fs.writeFile(DB_PATH, JSON.stringify(data, null, 2), "utf8"));
  return dbLock;
}

function nowISO() {
  return new Date().toISOString();
}

/* SSE clients voor live updates */
const sseClients = [];
function sendSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) { /* ignore */ }
  }
}

/* Haal API-keys uitsluitend uit environment variables (geen fallback naar db.json) */
function getAllowedApiKeysFromEnv() {
  if (process.env.API_KEY && process.env.API_KEY.trim()) {
    return [process.env.API_KEY.trim()];
  }
  if (process.env.API_KEYS && process.env.API_KEYS.trim()) {
    return process.env.API_KEYS.split(",").map(s => s.trim()).filter(Boolean);
  }
  return [];
}

/* Middleware: controleer API-key (x-api-key header of apiKey query param) 
   Let op: de server vereist dat keys zijn ingesteld via ENV; anders return 500 (misconfiguratie).
*/
async function verifyApiKey(req, res, next) {
  const allowed = getAllowedApiKeysFromEnv();
  if (!allowed || allowed.length === 0) {
    return res.status(500).json({ error: "Server misconfigured: no API keys set. Set API_KEY or API_KEYS environment variable." });
  }
  const key = req.header("x-api-key") || req.query.apiKey;
  if (!key || !allowed.includes(key)) {
    return res.status(401).json({ error: "Invalid or missing API key" });
  }
  req.operator = req.header("x-operator") || req.body.operator || "unknown";
  next();
}

/* Helper: aantal stempels vandaag voor een klant */
function stampsTodayForCustomer(db, customerId) {
  const today = new Date().toISOString().slice(0, 10);
  return db.stamps.filter(s => s.customerId === customerId && s.ts.slice(0, 10) === today).length;
}

/* -------------------- Routes -------------------- */

app.get("/api/health", (req, res) => res.json({ ok: true, now: nowISO() }));

app.post("/api/customers", async (req, res) => {
  const { name, phone, email } = req.body;
  if (!name || !phone) return res.status(400).json({ error: "name and phone are required" });

  const db = await readDB();
  let customer = db.customers.find(c => c.phone === phone.trim());
  if (customer) return res.json({ existing: true, customer });

  customer = { id: uuidv4(), name: name.trim(), phone: phone.trim(), email: email ? email.trim() : "", createdAt: nowISO() };
  db.customers.push(customer);
  db.logs.push({ type: "customer_created", ts: nowISO(), customerId: customer.id, name: customer.name });
  await writeDB(db);
  res.json({ customer });
});

app.get("/api/customers", async (req, res) => {
  const { phone, id } = req.query;
  const db = await readDB();
  let found;
  if (phone) found = db.customers.find(c => c.phone === phone);
  else if (id) found = db.customers.find(c => c.id === id);
  if (!found) return res.status(404).json({ error: "not found" });
  const stampsTotal = db.stamps.filter(s => s.customerId === found.id).length;
  const stampsToday = stampsTodayForCustomer(db, found.id);
  res.json({ customer: found, stampsTotal, stampsToday });
});

app.post("/api/stamps", verifyApiKey, async (req, res) => {
  const { customerId, phone } = req.body;
  const operator = req.operator;
  const db = await readDB();

  let customer = null;
  if (customerId) customer = db.customers.find(c => c.id === customerId);
  else if (phone) customer = db.customers.find(c => c.phone === phone);

  if (!customer) return res.status(404).json({ error: "customer not found" });

  const todayCount = stampsTodayForCustomer(db, customer.id);
  if (todayCount >= 3) return res.status(429).json({ error: "daily stamp limit reached", todayCount });

  const stamp = { id: uuidv4(), customerId: customer.id, ts: nowISO(), operator };
  db.stamps.push(stamp);
  db.logs.push({ type: "stamp", ts: nowISO(), customerId: customer.id, operator, stampId: stamp.id });
  await writeDB(db);

  const stampsTotal = db.stamps.filter(s => s.customerId === customer.id).length;
  sendSSE("stamp", { customerId: customer.id, stampsTotal, operator });
  res.json({ ok: true, stamp, stampsTotal });
});

const REWARD_THRESHOLD = parseInt(process.env.REWARD_THRESHOLD || "10", 10);
app.post("/api/redeem", verifyApiKey, async (req, res) => {
  const { customerId, phone, note } = req.body;
  const operator = req.operator;
  const db = await readDB();

  let customer = null;
  if (customerId) customer = db.customers.find(c => c.id === customerId);
  else if (phone) customer = db.customers.find(c => c.phone === phone);

  if (!customer) return res.status(404).json({ error: "customer not found" });

  const customerStamps = db.stamps.filter(s => s.customerId === customer.id);
  if (customerStamps.length < REWARD_THRESHOLD) return res.status(400).json({ error: "not enough stamps", current: customerStamps.length, required: REWARD_THRESHOLD });

  const sorted = customerStamps.sort((a, b) => new Date(a.ts) - new Date(b.ts));
  const toRemoveIds = sorted.slice(0, REWARD_THRESHOLD).map(s => s.id);
  db.stamps = db.stamps.filter(s => !toRemoveIds.includes(s.id));

  const redemption = { id: uuidv4(), customerId: customer.id, ts: nowISO(), operator, note: note || "" };
  db.redemptions.push(redemption);
  db.logs.push({ type: "redeem", ts: nowISO(), customerId: customer.id, operator, redemptionId: redemption.id });
  await writeDB(db);

  sendSSE("redeem", { customerId: customer.id, redemption });
  res.json({ ok: true, redemption });
});

app.get("/api/stats/overview", async (req, res) => {
  const db = await readDB();
  const totalCustomers = db.customers.length;
  const today = new Date().toISOString().slice(0, 10);
  const stampsToday = db.stamps.filter(s => s.ts.slice(0, 10) === today).length;
  const redeemedCount = db.redemptions.length;

  const counts = {};
  for (const s of db.stamps) counts[s.customerId] = (counts[s.customerId] || 0) + 1;
  const top = Object.entries(counts)
    .map(([customerId, count]) => {
      const customer = db.customers.find(c => c.id === customerId) || { id: customerId, name: "Unknown", phone: "" };
      return { customerId, name: customer.name, phone: customer.phone, count };
    })
    .sort((a, b) => b.count - a.count)
    .slice(0, 5);

  res.json({ totalCustomers, stampsToday, redeemedCount, top });
});

app.get("/sse", (req, res) => {
  res.set({ "Cache-Control": "no-cache", "Content-Type": "text/event-stream", Connection: "keep-alive" });
  res.flushHeaders();
  res.write("retry: 10000\n\n");
  sseClients.push(res);
  req.on("close", () => {
    const idx = sseClients.indexOf(res);
    if (idx !== -1) sseClients.splice(idx, 1);
  });
});

app.get("/wallet/:customerId", async (req, res) => {
  const { customerId } = req.params;
  const db = await readDB();
  const customer = db.customers.find(c => c.id === customerId);
  if (!customer) return res.status(404).send("Customer not found");

  const pass = { id: customer.id, name: customer.name, phone: customer.phone, createdAt: customer.createdAt, stamps: db.stamps.filter(s => s.customerId === customer.id).length, generatedAt: nowISO() };
  res.setHeader("Content-Disposition", `attachment; filename=stamp-card-${customer.id}.json`);
  res.setHeader("Content-Type", "application/json");
  res.send(JSON.stringify(pass, null, 2));
});

app.get("/api/logs", verifyApiKey, async (req, res) => {
  const db = await readDB();
  res.json({ logs: db.logs.slice().reverse().slice(0, 200) });
});

app.listen(PORT, () => {
  console.log(`Stamp-die-kaart server running on port ${PORT}`);
});
