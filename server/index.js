const express = require('express');
const cors = require('cors');
const fs = require('fs');
const path = require('path');
const { v4: uuidv4 } = require('uuid');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'db.json');

// Middleware
app.use(cors());
app.use(express.json());
app.use(express.static(path.join(__dirname, '../public')));

// In-memory database (geladen uit db.json)
let db = {
  customers: [],
  stamps: [],
  redemptions: [],
  logs: [],
  apiKeys: [],
  adminApiKeys: [],
  tokens: []
};

// Write queue voor db.json (voorkomt race conditions)
let writeQueue = Promise.resolve();

// Laad db.json bij opstarten
function loadDatabase() {
  try {
    if (fs.existsSync(DB_PATH)) {
      const data = fs.readFileSync(DB_PATH, 'utf8');
      db = JSON.parse(data);
      console.log('Database geladen uit db.json');
    }
  } catch (error) {
    console.error('Fout bij laden database:', error);
  }
}

// Sla database op naar db.json (via write queue)
function saveDatabase() {
  writeQueue = writeQueue.then(() => {
    return new Promise((resolve, reject) => {
      fs.writeFile(DB_PATH, JSON.stringify(db, null, 2), 'utf8', (err) => {
        if (err) {
          console.error('Fout bij opslaan database:', err);
          reject(err);
        } else {
          resolve();
        }
      });
    });
  });
  return writeQueue;
}

// SSE clients
const sseClients = [];

// Stuur SSE event naar alle clients
function sendSSE(eventType, data) {
  const message = `data: ${JSON.stringify({ type: eventType, data })}\n\n`;
  sseClients.forEach(client => {
    try {
      client.write(message);
    } catch (error) {
      console.error('Fout bij versturen SSE:', error);
    }
  });
}

// Log helper
function addLog(action, details) {
  const log = {
    id: uuidv4(),
    timestamp: new Date().toISOString(),
    action,
    details
  };
  db.logs.push(log);
  // Bewaar alleen laatste 1000 logs
  if (db.logs.length > 1000) {
    db.logs = db.logs.slice(-1000);
  }
  return log;
}

// Middleware: Verify API Key
function verifyApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  
  // Check environment variabelen eerst
  const envApiKey = process.env.API_KEY;
  const envApiKeys = process.env.API_KEYS ? process.env.API_KEYS.split(',') : [];
  
  if (envApiKey && apiKey === envApiKey) {
    return next();
  }
  
  if (envApiKeys.length > 0 && envApiKeys.includes(apiKey)) {
    return next();
  }
  
  // Fallback naar db.json
  if (db.apiKeys && db.apiKeys.includes(apiKey)) {
    return next();
  }
  
  return res.status(401).json({ error: 'Ongeldige API key' });
}

// Middleware: Verify Admin API Key
function requireAdminApiKey(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  
  // Check voor admin API key in environment
  const adminApiKey = process.env.ADMIN_API_KEY;
  
  if (adminApiKey && apiKey === adminApiKey) {
    req.operator = 'admin';
    return next();
  }
  
  // Fallback naar db.json admin keys
  if (db.adminApiKeys && db.adminApiKeys.includes(apiKey)) {
    req.operator = 'admin';
    return next();
  }
  
  return res.status(403).json({ error: 'Admin rechten vereist' });
}

// Helper: Database lezen
function readDB() {
  return db;
}

// Helper: Database schrijven
async function writeDB(newDb) {
  db = newDb;
  await saveDatabase();
}

// Routes

// GET /api/health - Health check
app.get('/api/health', (req, res) => {
  res.json({ 
    status: 'ok', 
    timestamp: new Date().toISOString(),
    uptime: process.uptime()
  });
});

// POST /api/customers - Registreer nieuwe klant
app.post('/api/customers', async (req, res) => {
  try {
    const { name, email, phone } = req.body;
    
    if (!name || !email) {
      return res.status(400).json({ error: 'Naam en email zijn verplicht' });
    }
    
    // Check of email al bestaat
    const existing = db.customers.find(c => c.email === email);
    if (existing) {
      return res.status(409).json({ error: 'Email bestaat al', customerId: existing.id });
    }
    
    const customer = {
      id: uuidv4(),
      name,
      email,
      phone: phone || '',
      stamps: 0,
      createdAt: new Date().toISOString()
    };
    
    db.customers.push(customer);
    addLog('customer_registered', { customerId: customer.id, name, email });
    await saveDatabase();
    
    // Stuur SSE event
    sendSSE('customer_registered', customer);
    
    res.status(201).json(customer);
  } catch (error) {
    console.error('Fout bij registreren klant:', error);
    res.status(500).json({ error: 'Server fout' });
  }
});

// GET /api/customers - Haal alle klanten op
app.get('/api/customers', (req, res) => {
  res.json(db.customers);
});

// POST /api/stamps - Voeg stempel toe (vereist API key)
app.post('/api/stamps', verifyApiKey, async (req, res) => {
  try {
    const { customerId } = req.body;
    
    if (!customerId) {
      return res.status(400).json({ error: 'customerId is verplicht' });
    }
    
    const customer = db.customers.find(c => c.id === customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Klant niet gevonden' });
    }
    
    const stamp = {
      id: uuidv4(),
      customerId,
      timestamp: new Date().toISOString()
    };
    
    db.stamps.push(stamp);
    customer.stamps += 1;
    
    addLog('stamp_added', { customerId, stampId: stamp.id, totalStamps: customer.stamps });
    await saveDatabase();
    
    // Stuur SSE event
    sendSSE('stamp_added', { customerId, stamps: customer.stamps });
    
    res.status(201).json({ 
      stamp, 
      customer: {
        id: customer.id,
        name: customer.name,
        stamps: customer.stamps
      }
    });
  } catch (error) {
    console.error('Fout bij toevoegen stempel:', error);
    res.status(500).json({ error: 'Server fout' });
  }
});

// POST /api/redeem - Verzilver stempels (vereist API key)
app.post('/api/redeem', verifyApiKey, async (req, res) => {
  try {
    const { customerId, stampsRequired = 10 } = req.body;
    
    if (!customerId) {
      return res.status(400).json({ error: 'customerId is verplicht' });
    }
    
    const customer = db.customers.find(c => c.id === customerId);
    if (!customer) {
      return res.status(404).json({ error: 'Klant niet gevonden' });
    }
    
    if (customer.stamps < stampsRequired) {
      return res.status(400).json({ 
        error: 'Onvoldoende stempels',
        current: customer.stamps,
        required: stampsRequired
      });
    }
    
    const redemption = {
      id: uuidv4(),
      customerId,
      stampsUsed: stampsRequired,
      timestamp: new Date().toISOString()
    };
    
    db.redemptions.push(redemption);
    customer.stamps -= stampsRequired;
    
    addLog('redemption', { customerId, redemptionId: redemption.id, stampsUsed: stampsRequired, remainingStamps: customer.stamps });
    await saveDatabase();
    
    // Stuur SSE event
    sendSSE('redemption', { customerId, stamps: customer.stamps, stampsUsed: stampsRequired });
    
    res.json({ 
      redemption,
      customer: {
        id: customer.id,
        name: customer.name,
        stamps: customer.stamps
      }
    });
  } catch (error) {
    console.error('Fout bij verzilveren:', error);
    res.status(500).json({ error: 'Server fout' });
  }
});

// GET /api/stats/overview - Statistieken overzicht
app.get('/api/stats/overview', (req, res) => {
  const stats = {
    totalCustomers: db.customers.length,
    totalStamps: db.stamps.length,
    totalRedemptions: db.redemptions.length,
    activeCustomers: db.customers.filter(c => c.stamps > 0).length,
    topCustomers: db.customers
      .sort((a, b) => b.stamps - a.stamps)
      .slice(0, 5)
      .map(c => ({ id: c.id, name: c.name, stamps: c.stamps }))
  };
  
  res.json(stats);
});

// GET /sse - Server-Sent Events endpoint
app.get('/sse', (req, res) => {
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  
  // Stuur initiële connectie bericht
  res.write(`data: ${JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() })}\n\n`);
  
  // Voeg client toe aan lijst
  sseClients.push(res);
  
  // Verwijder client bij disconnect
  req.on('close', () => {
    const index = sseClients.indexOf(res);
    if (index !== -1) {
      sseClients.splice(index, 1);
    }
  });
});

// GET /wallet/:customerId - Wallet view voor klant
app.get('/wallet/:customerId', (req, res) => {
  const customer = db.customers.find(c => c.id === req.params.customerId);
  
  if (!customer) {
    return res.status(404).send(`
      <!DOCTYPE html>
      <html lang="nl">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Klant niet gevonden</title>
        <style>
          body { font-family: Arial, sans-serif; padding: 20px; text-align: center; }
          .error { color: #d32f2f; margin-top: 50px; }
        </style>
      </head>
      <body>
        <div class="error">
          <h1>Klant niet gevonden</h1>
          <p>De opgegeven klant-ID is ongeldig.</p>
        </div>
      </body>
      </html>
    `);
  }
  
  res.send(`
    <!DOCTYPE html>
    <html lang="nl">
    <head>
      <meta charset="UTF-8">
      <meta name="viewport" content="width=device-width, initial-scale=1.0">
      <title>Mijn Stempelkaart - ${customer.name}</title>
      <style>
        body {
          font-family: Arial, sans-serif;
          margin: 0;
          padding: 20px;
          background: linear-gradient(135deg, #667eea 0%, #764ba2 100%);
          min-height: 100vh;
        }
        .container {
          max-width: 400px;
          margin: 0 auto;
          background: white;
          border-radius: 15px;
          padding: 30px;
          box-shadow: 0 10px 30px rgba(0,0,0,0.3);
        }
        h1 {
          color: #333;
          margin-top: 0;
          font-size: 24px;
        }
        .customer-info {
          background: #f5f5f5;
          padding: 15px;
          border-radius: 8px;
          margin-bottom: 20px;
        }
        .stamps-container {
          display: grid;
          grid-template-columns: repeat(5, 1fr);
          gap: 10px;
          margin: 20px 0;
        }
        .stamp {
          aspect-ratio: 1;
          border: 2px dashed #ddd;
          border-radius: 8px;
          display: flex;
          align-items: center;
          justify-content: center;
          font-size: 30px;
        }
        .stamp.filled {
          background: #667eea;
          border: 2px solid #667eea;
          color: white;
        }
        .progress {
          text-align: center;
          font-size: 18px;
          color: #666;
          margin-top: 20px;
        }
        .progress strong {
          color: #667eea;
          font-size: 24px;
        }
      </style>
    </head>
    <body>
      <div class="container">
        <h1>🎫 Mijn Stempelkaart</h1>
        <div class="customer-info">
          <div><strong>Naam:</strong> ${customer.name}</div>
          <div><strong>Email:</strong> ${customer.email}</div>
        </div>
        <div class="stamps-container" id="stampsGrid">
          ${Array(10).fill(0).map((_, i) => 
            `<div class="stamp ${i < customer.stamps ? 'filled' : ''}">
              ${i < customer.stamps ? '⭐' : ''}
            </div>`
          ).join('')}
        </div>
        <div class="progress">
          <strong>${customer.stamps}</strong> / 10 stempels
          ${customer.stamps >= 10 ? '<br>🎉 Je hebt een gratis product verdiend!' : ''}
        </div>
      </div>
      
      <script>
        // Live updates via SSE
        const eventSource = new EventSource('/sse');
        eventSource.onmessage = (event) => {
          const data = JSON.parse(event.data);
          if (data.type === 'stamp_added' && data.data.customerId === '${customer.id}') {
            location.reload();
          }
          if (data.type === 'redemption' && data.data.customerId === '${customer.id}') {
            location.reload();
          }
        };
      </script>
    </body>
    </html>
  `);
});

// POST /api/operators/revoke - Revoke tokens (vereist admin API key)
app.post('/api/operators/revoke', requireAdminApiKey, async (req, res) => {
  try {
    const { token, operatorId, operatorName } = req.body;
    
    // Validatie: minimaal één parameter moet aanwezig zijn
    if (!token && !operatorId && !operatorName) {
      return res.status(400).json({ 
        error: 'Minimaal één van de volgende parameters is verplicht: token, operatorId, operatorName' 
      });
    }
    
    const currentDb = readDB();
    let tokensToRemove = [];
    let removed = [];
    
    // Filter tokens op basis van de meegegeven criteria
    if (token) {
      // Revoke specifieke token
      tokensToRemove = currentDb.tokens.filter(t => t.token === token);
      currentDb.tokens = currentDb.tokens.filter(t => t.token !== token);
    } else if (operatorId) {
      // Revoke alle tokens van een operator (op basis van ID)
      tokensToRemove = currentDb.tokens.filter(t => t.operatorId === operatorId);
      currentDb.tokens = currentDb.tokens.filter(t => t.operatorId !== operatorId);
    } else if (operatorName) {
      // Revoke alle tokens van een operator (op basis van naam)
      tokensToRemove = currentDb.tokens.filter(t => t.operatorName === operatorName);
      currentDb.tokens = currentDb.tokens.filter(t => t.operatorName !== operatorName);
    }
    
    // Maak samenvatting van verwijderde tokens
    removed = tokensToRemove.map(t => ({
      token: t.token,
      operatorId: t.operatorId,
      operatorName: t.operatorName
    }));
    
    // Log de actie
    addLog('token_revoke', {
      performedBy: req.operator || 'admin',
      token: token || null,
      operatorId: operatorId || null,
      operatorName: operatorName || null,
      removed: removed
    });
    
    // Schrijf database
    await writeDB(currentDb);
    
    // Stuur SSE event
    sendSSE('token_revoked', { 
      performedBy: req.operator || 'admin',
      removed: removed.length 
    });
    
    res.json({ 
      ok: true, 
      removed: removed
    });
  } catch (error) {
    console.error('Fout bij revoking token:', error);
    res.status(500).json({ error: 'Server fout' });
  }
});

// GET /api/logs - Haal logs op
app.get('/api/logs', (req, res) => {
  const limit = parseInt(req.query.limit) || 100;
  const logs = db.logs.slice(-limit).reverse();
  res.json(logs);
});

// Laad database bij opstarten
loadDatabase();

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Stamp-die-kaart server draait op http://localhost:${PORT}`);
  console.log(`   Environment: ${process.env.NODE_ENV || 'development'}`);
  console.log(`   API Keys: ${process.env.API_KEY || process.env.API_KEYS ? 'ENV' : 'db.json'}`);
});
