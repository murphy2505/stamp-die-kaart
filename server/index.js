const express = require("express");
const fs = require("fs").promises;
const path = require("path");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const crypto = require('crypto');

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
      apiKeys: [],
      operators: [],
      tokens: []
    };
  }
}

async function writeDB(data) {
  dbLock = dbLock.then(() => fs.writeFile(DB_PATH, JSON.stringify(data, null, 2), "utf8"));
  return dbLock;
}

function nowISO() { return new Date().toISOString(); }

/* SSE clients voor live updates */
const sseClients = [];
function sendSSE(event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of sseClients) {
    try { res.write(payload); } catch (e) { /* ignore */ }
  }
}

/* API keys uit env (recommended) */
function getAllowedApiKeysFromEnv() {
  if (process.env.API_KEY && process.env.API_KEY.trim()) return [process.env.API_KEY.trim()];
  if (process.env.API_KEYS && process.env.API_KEYS.trim()) return process.env.API_KEYS.split(",").map(s=>s.trim()).filter(Boolean);
  return [];
}

/* helpers voor operator PIN hashing */
function hashPin(pin) {
  return crypto.createHash('sha256').update(String(pin)).digest('hex');
}

/* Token helpers */
function tokenExpiresAt(ttlMs) {
  return new Date(Date.now() + ttlMs).toISOString();
}

/* Auth helpers: accept either admin API key or operator token for operator actions */
async function getOperatorFromRequest(req) {
  const allowed = getAllowedApiKeysFromEnv();
  const apiKey = req.header('x-api-key') || req.query.apiKey;
  if (apiKey && allowed.includes(apiKey)) {
    return req.header('x-operator') || 'api';
  }

  // check token
  const auth = req.header('authorization') || '';
  let token = null;
  if (auth.toLowerCase().startsWith('bearer ')) token = auth.slice(7).trim();
  if (!token) token = req.header('x-token');
  if (!token) return null;

  const db = await readDB();
  const t = db.tokens.find(tt => tt.token === token);
  if (!t) return null;
  if (new Date(t.expiresAt) < new Date()) return null;
  const op = db.operators.find(o => o.id === t.operatorId);
  return op ? op.name : null;
}

/* Middleware used for endpoints that require either API key or operator token */
async function requireOperatorOrApiKey(req, res, next) {
  const operator = await getOperatorFromRequest(req);
  if (!operator) return res.status(401).json({ error: 'Invalid or missing API key/token' });
  req.operator = operator;
  next();
}

/* Admin-only middleware: requires API key (not token) */
async function requireAdminApiKey(req, res, next) {
  const allowed = getAllowedApiKeysFromEnv();
  if (!allowed || allowed.length === 0) return res.status(500).json({ error: 'Server misconfigured: no API keys set.' });
  const apiKey = req.header('x-api-key') || req.query.apiKey;
  if (!apiKey || !allowed.includes(apiKey)) return res.status(401).json({ error: 'Invalid or missing API key' });
  req.operator = req.header('x-operator') || 'admin';
  next();
}

function stampsTodayForCustomer(db, customerId) {
  const today = new Date().toISOString().slice(0,10);
  return db.stamps.filter(s => s.customerId === customerId && s.ts.slice(0,10) === today).length;
}

/* Routes */
app.get('/api/health', (req,res) => res.json({ ok:true, now: nowISO() }));

// Create operator (admin only)
app.post('/api/operators', requireAdminApiKey, async (req,res) => {
  const { name, pin } = req.body;
  if (!name || !pin) return res.status(400).json({ error: 'name and pin required' });
  const db = await readDB();
  const op = { id: uuidv4(), name: name.trim(), pinHash: hashPin(pin), createdAt: nowISO() };
  db.operators.push(op);
  db.logs.push({ type:'operator_created', ts: nowISO(), operatorId: op.id, name: op.name, performedBy: req.operator });
  await writeDB(db);
  res.json({ operator: { id: op.id, name: op.name } });
});

// Operator login -> returns short-lived token
app.post('/api/operators/login', async (req,res) => {
  const { operatorId, name, pin } = req.body;
  if ((!operatorId && !name) || !pin) return res.status(400).json({ error: 'operatorId or name and pin required' });
  const db = await readDB();
  let op = null;
  if (operatorId) op = db.operators.find(o => o.id === operatorId);
  else op = db.operators.find(o => o.name === name);
  if (!op) return res.status(404).json({ error: 'operator not found' });
  if (op.pinHash !== hashPin(pin)) return res.status(401).json({ error: 'invalid credentials' });

  const ttl = parseInt(process.env.TOKEN_TTL_MS || '3600000', 10); // default 1 hour
  const token = uuidv4();
  const expiresAt = tokenExpiresAt(ttl);
  db.tokens.push({ token, operatorId: op.id, createdAt: nowISO(), expiresAt });
  db.logs.push({ type:'operator_login', ts: nowISO(), operatorId: op.id, performedBy: op.name });
  await writeDB(db);
  res.json({ token, expiresAt, operator: { id: op.id, name: op.name } });
});

// Create customer
app.post('/api/customers', requireAdminApiKey, async (req,res) => {
  const { name, phone, email } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'name and phone are required' });
  const db = await readDB();
  let customer = db.customers.find(c => c.phone === phone.trim());
  if (customer) return res.json({ existing: true, customer });
  customer = { id: uuidv4(), name: name.trim(), phone: phone.trim(), email: email ? email.trim() : '', createdAt: nowISO() };
  db.customers.push(customer);
  db.logs.push({ type: 'customer_created', ts: nowISO(), customerId: customer.id, performedBy: req.operator });
  await writeDB(db);
  res.json({ customer });
});

app.get('/api/customers', async (req,res) => {
  const { phone, id } = req.query;
  const db = await readDB();
  let found;
  if (phone) found = db.customers.find(c => c.phone === phone);
  else if (id) found = db.customers.find(c => c.id === id);
  if (!found) return res.status(404).json({ error: 'not found' });
  const stampsTotal = db.stamps.filter(s => s.customerId === found.id).length;
  const stampsToday = stampsTodayForCustomer(db, found.id);
  res.json({ customer: found, stampsTotal, stampsToday });
});

// Add stamp: allow operator token OR admin API key
app.post('/api/stamps', requireOperatorOrApiKey, async (req,res) => {
  const { customerId, phone } = req.body;
  const operator = req.operator;
  const db = await readDB();
  let customer = null;
  if (customerId) customer = db.customers.find(c => c.id === customerId);
  else if (phone) customer = db.customers.find(c => c.phone === phone);
  if (!customer) return res.status(404).json({ error: 'customer not found' });
  const todayCount = stampsTodayForCustomer(db, customer.id);
  if (todayCount >= 3) return res.status(429).json({ error: 'daily stamp limit reached', todayCount });
  const stamp = { id: uuidv4(), customerId: customer.id, ts: nowISO(), operator };
  db.stamps.push(stamp);
  db.logs.push({ type: 'stamp', ts: nowISO(), customerId: customer.id, operator, stampId: stamp.id });
  await writeDB(db);
  const stampsTotal = db.stamps.filter(s => s.customerId === customer.id).length;
  sendSSE('stamp', { customerId: customer.id, stampsTotal, operator });
  res.json({ ok: true, stamp, stampsTotal });
});

// Redeem: allow operator token OR admin API key
const REWARD_THRESHOLD = parseInt(process.env.REWARD_THRESHOLD || '10', 10);
app.post('/api/redeem', requireOperatorOrApiKey, async (req,res) => {
  const { customerId, phone, note } = req.body;
  const operator = req.operator;
  const db = await readDB();
  let customer = null;
  if (customerId) customer = db.customers.find(c => c.id === customerId);
  else if (phone) customer = db.customers.find(c => c.phone === phone);
  if (!customer) return res.status(404).json({ error: 'customer not found' });
  const customerStamps = db.stamps.filter(s => s.customerId === customer.id);
  if (customerStamps.length < REWARD_THRESHOLD) return res.status(400).json({ error: 'not enough stamps', current: customerStamps.length, required: REWARD_THRESHOLD });
  const sorted = customerStamps.sort((a,b)=> new Date(a.ts)-new Date(b.ts));
  const toRemoveIds = sorted.slice(0, REWARD_THRESHOLD).map(s=>s.id);
  db.stamps = db.stamps.filter(s => !toRemoveIds.includes(s.id));
  const redemption = { id: uuidv4(), customerId: customer.id, ts: nowISO(), operator, note: note || '' };
  db.redemptions.push(redemption);
  db.logs.push({ type: 'redeem', ts: nowISO(), customerId: customer.id, operator, redemptionId: redemption.id });
  await writeDB(db);
  sendSSE('redeem', { customerId: customer.id, redemption });
  res.json({ ok: true, redemption });
});

app.get('/api/stats/overview', async (req,res) => {
  const db = await readDB();
  const totalCustomers = db.customers.length;
  const today = new Date().toISOString().slice(0,10);
  const stampsToday = db.stamps.filter(s => s.ts.slice(0,10) === today).length;
  const redeemedCount = db.redemptions.length;
  const counts = {};
  for (const s of db.stamps) counts[s.customerId] = (counts[s.customerId] || 0) + 1;
  const top = Object.entries(counts).map(([customerId,count])=>{ const customer = db.customers.find(c=>c.id===customerId) || { id: customerId, name:'Unknown', phone: '' }; return { customerId, name: customer.name, phone: customer.phone, count }; }).sort((a,b)=>b.count-a.count).slice(0,5);
  res.json({ totalCustomers, stampsToday, redeemedCount, top });
});

app.get('/sse', (req,res) => {
  res.set({ 'Cache-Control': 'no-cache', 'Content-Type': 'text/event-stream', Connection: 'keep-alive' });
  res.flushHeaders();
  res.write('retry: 10000\n\n');
  sseClients.push(res);
  req.on('close', ()=>{ const idx = sseClients.indexOf(res); if (idx !== -1) sseClients.splice(idx,1); });
});

app.get('/wallet/:customerId', async (req,res)=>{
  const { customerId } = req.params;
  const db = await readDB();
  const customer = db.customers.find(c => c.id === customerId);
  if (!customer) return res.status(404).send('Customer not found');
  const pass = { id: customer.id, name: customer.name, phone: customer.phone, createdAt: customer.createdAt, stamps: db.stamps.filter(s => s.customerId === customer.id).length, generatedAt: nowISO() };
  res.setHeader('Content-Disposition', `attachment; filename=stamp-card-${customer.id}.json`);
  res.setHeader('Content-Type', 'application/json');
  res.send(JSON.stringify(pass, null, 2));
});

// Logs: admin only
app.get('/api/logs', requireAdminApiKey, async (req,res)=>{ const db = await readDB(); res.json({ logs: db.logs.slice().reverse().slice(0,200) }); });

app.listen(PORT, ()=>{ console.log(`Stamp-die-kaart server running on port ${PORT}`); });