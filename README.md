# Stamp-die-kaart — MVP backend + frontend

Minimalistische MVP van het spaarsysteem voor Cafetaria 't Centrum.
Dit bevat een Node/Express backend met eenvoudige JSON-opslag en een kleine frontend (register/popup/dashboard) geschikt voor gebruik op een Sunmi D3 Pro.

Inhoud van deze branch:
- server/index.js  — Express API + SSE + db.json persistence
- server/db.json   — eenvoudige file-based DB (leeg) with no keys
- public/*         — register.html, popup.html, dashboard.html (frontend)
- Dockerfile       — eenvoudige container voor productie
- package.json

Belangrijkste features:
- Klantregistratie (naam, telefoon, e-mail optioneel)
- +1 stempel, beloning inwisselen (operator acties via x-api-key)
- Anti-fraude: max 3 stempels per klant per dag
- SSE (/sse) voor live updates (dashboard/popup)
- Wallet: /wallet/:customerId levert een downloadbare JSON-pass (geen .pkpass)

API key requirement:
- The server requires API_KEY or API_KEYS be set in the environment. There is no fallback key in files.
  - export API_KEY="your-secret-key"
  - or export API_KEYS="key1,key2"

Lokaal draaien (npm):
1. node 14+ aanbevolen
2. npm install
3. export API_KEY="your-secret-key"
4. npm start

Draaien met Docker:
1. docker build -t stamp-die-kaart .
2. docker run -p 3000:3000 -e API_KEY=your-secret-key stamp-die-kaart

Beperkingen (MVP):
- Data wordt opgeslagen in server/db.json (file-based). Voor productie: migreer naar SQLite/Postgres/Mongo.
- Wallet is een eenvoudige JSON-download; geen echte Apple/Google Wallet integratie.
- Dashboard is niet beveiligd (overweeg basic-auth of operator accounts).

