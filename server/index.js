const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const fs = require('fs').promises;
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.json');

// Middleware
app.use(cors());
app.use(express.json());

// SSE clients array
let sseClients = [];

// Database lock for write operations
let dbLock = Promise.resolve();

// Helper: Read database
async function readDb() {
  try {
    const data = await fs.readFile(DB_PATH, 'utf8');
    return JSON.parse(data);
  } catch (err) {
    console.error('Error reading database:', err);
    throw err;
  }
}

// Helper: Write database with queue/lock to prevent race conditions
async function writeDb(data) {
  dbLock = dbLock.then(async () => {
    await fs.writeFile(DB_PATH, JSON.stringify(data, null, 2), 'utf8');
  });
  return dbLock;
}

// Helper: Send SSE event to all connected clients
function sendSSE(event, data) {
  const message = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  sseClients.forEach((client, index) => {
    try {
      client.write(message);
    } catch (err) {
      console.error('Error writing to SSE client:', err);
      // Client will be removed on 'close' event
    }
  });
}

// Middleware: Verify API Key
function verifyApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'] || req.query.apiKey;
  const operator = req.headers['x-operator'] || req.body?.operator || 'unknown';
  
  readDb().then(db => {
    if (!apiKey || !db.apiKeys.includes(apiKey)) {
      return res.status(401).json({ error: 'Unauthorized: Invalid API key' });
    }
    req.operator = operator;
    next();
  }).catch(err => {
    res.status(500).json({ error: 'Internal server error' });
  });
}

// Routes

// GET /api/health
app.get('/api/health', (req, res) => {
  res.json({ status: 'ok', timestamp: new Date().toISOString() });
});

// POST /api/customers - Create or return existing customer (dedupe on phone)
app.post('/api/customers', async (req, res) => {
  try {
    const { naam, phone } = req.body;
    
    if (!naam || !phone) {
      return res.status(400).json({ error: 'naam and phone are required' });
    }
    
    const db = await readDb();
    
    // Check if customer already exists (dedupe on phone)
    let customer = db.customers.find(c => c.phone === phone);
    
    if (customer) {
      return res.json(customer);
    }
    
    // Create new customer
    customer = {
      id: uuidv4(),
      naam,
      phone,
      createdAt: new Date().toISOString()
    };
    
    db.customers.push(customer);
    await writeDb(db);
    
    res.status(201).json(customer);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/customers - Get customer by phone or id
app.get('/api/customers', async (req, res) => {
  try {
    const { phone, id } = req.query;
    
    if (!phone && !id) {
      return res.status(400).json({ error: 'phone or id parameter required' });
    }
    
    const db = await readDb();
    const customer = db.customers.find(c => 
      (phone && c.phone === phone) || (id && c.id === id)
    );
    
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    // Calculate stamps
    const customerStamps = db.stamps.filter(s => s.customerId === customer.id && !s.redeemed);
    const stampsTotal = customerStamps.length;
    
    // Calculate stamps today
    const today = new Date().toISOString().split('T')[0];
    const stampsToday = customerStamps.filter(s => 
      s.createdAt.startsWith(today)
    ).length;
    
    res.json({
      ...customer,
      stampsTotal,
      stampsToday
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/stamps - Add stamp (requires API key, anti-fraud: max 3/day)
app.post('/api/stamps', verifyApiKey, async (req, res) => {
  try {
    const { customerId, phone } = req.body;
    
    if (!customerId && !phone) {
      return res.status(400).json({ error: 'customerId or phone required' });
    }
    
    const db = await readDb();
    
    // Find customer
    let customer = db.customers.find(c => 
      (customerId && c.id === customerId) || (phone && c.phone === phone)
    );
    
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    // Anti-fraud: max 3 stamps per day
    const today = new Date().toISOString().split('T')[0];
    const stampsToday = db.stamps.filter(s => 
      s.customerId === customer.id && s.createdAt.startsWith(today)
    ).length;
    
    if (stampsToday >= 3) {
      return res.status(429).json({ error: 'Maximum 3 stamps per day reached' });
    }
    
    // Create stamp
    const stamp = {
      id: uuidv4(),
      customerId: customer.id,
      createdAt: new Date().toISOString(),
      redeemed: false,
      operator: req.operator
    };
    
    db.stamps.push(stamp);
    
    // Log the action
    db.logs.push({
      id: uuidv4(),
      type: 'stamp',
      customerId: customer.id,
      operator: req.operator,
      timestamp: new Date().toISOString()
    });
    
    await writeDb(db);
    
    // Send SSE event
    sendSSE('stamp', {
      customerId: customer.id,
      customerName: customer.naam,
      stampId: stamp.id
    });
    
    res.status(201).json(stamp);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// POST /api/redeem - Redeem stamps (requires API key)
app.post('/api/redeem', verifyApiKey, async (req, res) => {
  try {
    const { customerId, phone, count } = req.body;
    
    if (!customerId && !phone) {
      return res.status(400).json({ error: 'customerId or phone required' });
    }
    
    if (!count || count < 1) {
      return res.status(400).json({ error: 'count must be at least 1' });
    }
    
    const db = await readDb();
    
    // Find customer
    let customer = db.customers.find(c => 
      (customerId && c.id === customerId) || (phone && c.phone === phone)
    );
    
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    // Get unredeemed stamps (oldest first)
    const unredeemedStamps = db.stamps
      .filter(s => s.customerId === customer.id && !s.redeemed)
      .sort((a, b) => new Date(a.createdAt) - new Date(b.createdAt));
    
    if (unredeemedStamps.length < count) {
      return res.status(400).json({ 
        error: `Insufficient stamps. Customer has ${unredeemedStamps.length} but ${count} requested` 
      });
    }
    
    // Mark stamps as redeemed
    const redeemedStampIds = unredeemedStamps.slice(0, count).map(s => s.id);
    db.stamps.forEach(s => {
      if (redeemedStampIds.includes(s.id)) {
        s.redeemed = true;
        s.redeemedAt = new Date().toISOString();
      }
    });
    
    // Create redemption record
    const redemption = {
      id: uuidv4(),
      customerId: customer.id,
      stampIds: redeemedStampIds,
      count,
      operator: req.operator,
      createdAt: new Date().toISOString()
    };
    
    db.redemptions.push(redemption);
    
    // Log the action
    db.logs.push({
      id: uuidv4(),
      type: 'redeem',
      customerId: customer.id,
      count,
      operator: req.operator,
      timestamp: new Date().toISOString()
    });
    
    await writeDb(db);
    
    // Send SSE event
    sendSSE('redeem', {
      customerId: customer.id,
      customerName: customer.naam,
      count,
      redemptionId: redemption.id
    });
    
    res.json(redemption);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/stats/overview - Get statistics
app.get('/api/stats/overview', async (req, res) => {
  try {
    const db = await readDb();
    
    const totalCustomers = db.customers.length;
    
    // Stamps today
    const today = new Date().toISOString().split('T')[0];
    const stampsToday = db.stamps.filter(s => s.createdAt.startsWith(today)).length;
    
    // Redeemed count
    const redeemedCount = db.redemptions.length;
    
    // Group stamps by customerId for efficient counting
    const stampsByCustomer = {};
    db.stamps.forEach(stamp => {
      if (!stamp.redeemed) {
        stampsByCustomer[stamp.customerId] = (stampsByCustomer[stamp.customerId] || 0) + 1;
      }
    });
    
    // Top 5 customers by stamp count
    const customerStampCounts = db.customers.map(customer => ({
      id: customer.id,
      naam: customer.naam,
      phone: customer.phone,
      stampCount: stampsByCustomer[customer.id] || 0
    }));
    
    const topCustomers = customerStampCounts
      .sort((a, b) => b.stampCount - a.stampCount)
      .slice(0, 5);
    
    res.json({
      totalCustomers,
      stampsToday,
      redeemedCount,
      topCustomers
    });
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /sse - Server-Sent Events endpoint
app.get('/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Add client to list
  sseClients.push(res);
  
  // Send initial connection message
  res.write(`event: connected\ndata: ${JSON.stringify({ message: 'Connected to SSE' })}\n\n`);
  
  // Remove client on disconnect
  req.on('close', () => {
    sseClients = sseClients.filter(client => client !== res);
  });
});

// GET /wallet/:customerId - Download wallet pass (simple JSON)
app.get('/wallet/:customerId', async (req, res) => {
  try {
    const { customerId } = req.params;
    const db = await readDb();
    
    const customer = db.customers.find(c => c.id === customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Customer not found' });
    }
    
    const stamps = db.stamps.filter(s => s.customerId === customerId && !s.redeemed);
    
    const walletData = {
      type: 'StampCard',
      businessName: 'Stamp-die-kaart',
      customer: {
        id: customer.id,
        naam: customer.naam,
        phone: customer.phone
      },
      stamps: stamps.length,
      createdAt: customer.createdAt,
      lastUpdated: new Date().toISOString()
    };
    
    res.setHeader('Content-Disposition', `attachment; filename="wallet-${customerId}.json"`);
    res.setHeader('Content-Type', 'application/json');
    res.json(walletData);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// GET /api/logs - Get logs (requires API key)
app.get('/api/logs', verifyApiKey, async (req, res) => {
  try {
    const db = await readDb();
    res.json(db.logs);
  } catch (err) {
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Serve static files from /public
app.use('/public', express.static(path.join(__dirname, '..', 'public')));
app.use('/', express.static(path.join(__dirname, '..', 'public')));

// Start server
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  console.log(`Health check: http://localhost:${PORT}/api/health`);
  console.log(`SSE endpoint: http://localhost:${PORT}/sse`);
});
