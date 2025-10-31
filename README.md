# Stamp-die-kaart 🎫

Een eenvoudige stempelkaart applicatie met Express API en frontend voor loyaliteitsprogramma's.

## Features

- ✅ Klantregistratie met unieke wallet links
- ⭐ Stempels toevoegen via POS terminal (met API key authenticatie)
- 🎁 Stempels verzilveren voor beloningen
- 📊 Real-time dashboard met Server-Sent Events (SSE)
- 💳 Mobiele wallet view voor klanten
- 🔐 API key authenticatie via environment variabelen of db.json

## Lokaal draaien

### Vereisten
- Node.js 18 of hoger
- npm

### Installatie en starten

```bash
# Installeer dependencies
npm install

# Start de server
npm start
```

De applicatie draait op http://localhost:3000

### API Key configuratie

Standaard gebruikt de applicatie de demo API key uit `server/db.json`: `demo-key-123`

Voor productie gebruik, stel een environment variabele in:

```bash
# Enkele API key
API_KEY=jouw-geheime-key npm start

# Meerdere API keys (komma gescheiden)
API_KEYS=key1,key2,key3 npm start
```

Environment keys hebben prioriteit boven keys in db.json.

## Docker gebruiken

### Image bouwen

```bash
docker build -t stamp-die-kaart .
```

### Container draaien

```bash
# Met demo key
docker run -p 3000:3000 -e API_KEY=demo-key-123 stamp-die-kaart

# Met custom keys
docker run -p 3000:3000 -e API_KEYS=secure-key-1,secure-key-2 stamp-die-kaart

# Met volume voor persistente data
docker run -p 3000:3000 -e API_KEY=demo-key-123 -v $(pwd)/data:/app/server stamp-die-kaart
```

De applicatie is beschikbaar op http://localhost:3000

## Beschikbare pagina's

- **`/register.html`** - Registratiepagina voor nieuwe klanten
- **`/popup.html`** - POS terminal interface (Sunmi popup) voor stempels toevoegen/verzilveren
- **`/dashboard.html`** - Live dashboard met statistieken en activiteiten
- **`/wallet/:customerId`** - Persoonlijke wallet view voor klanten (automatisch gegenereerd na registratie)

## API Endpoints

### Publieke endpoints

- `GET /api/health` - Health check
- `POST /api/customers` - Registreer nieuwe klant
- `GET /api/customers` - Haal alle klanten op
- `GET /api/stats/overview` - Statistieken overzicht
- `GET /api/logs` - Haal activity logs op
- `GET /sse` - Server-Sent Events voor live updates

### Beveiligde endpoints (vereist x-api-key header)

- `POST /api/stamps` - Voeg stempel toe
- `POST /api/redeem` - Verzilver stempels

## Data persistentie

De applicatie gebruikt `server/db.json` voor data opslag. Dit is een eenvoudig JSON bestand met:
- Klanten
- Stempels
- Verzilveringen
- Activity logs
- API keys

**Let op**: Voor productie gebruik wordt een echte database aanbevolen.

## Limitaties & Aanbevelingen

⚠️ Deze MVP heeft enkele limitaties:
- Gebruikt JSON bestand voor opslag (niet schaalbaar voor productie)
- Eenvoudige in-memory wallet implementatie
- Geen externe SDKs of Play Services
- Beperkte error handling en validatie

Voor productie:
- Gebruik een echte database (PostgreSQL, MongoDB, etc.)
- Implementeer rate limiting
- Voeg gebruikersauthenticatie toe
- Gebruik HTTPS
- Bewaar API keys in secure vault (niet in db.json)
- Implementeer backup strategie

## Technologie stack

- **Backend**: Node.js, Express
- **Frontend**: Vanilla JavaScript, HTML, CSS
- **Dependencies**: express, cors, uuid
- **Deployment**: Docker

## Licentie

ISC