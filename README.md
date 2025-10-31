# Stamp-die-kaart — MVP backend + frontend (updated)

Added operator token flow. Short summary:

- Operators: create operators via admin API (POST /api/operators with admin API key). Body: { name, pin }.
- Login: POST /api/operators/login with { operatorId } or { name, pin } -> returns { token, expiresAt, operator }.
- Operator token: use Authorization: Bearer <token> header or x-token header when calling /api/stamps or /api/redeem.
- Token TTL: controlled by env TOKEN_TTL_MS (default 3600000 = 1h).

Run locally:
1. export API_KEY="your-admin-key"
2. npm install
3. npm start
4. As admin create operator:
   curl -X POST http://localhost:3000/api/operators -H "Content-Type: application/json" -H "x-api-key:your-admin-key" -d '{"name":"kassa1","pin":"1234"}'
5. On Sunmi/popup login:
   POST /api/operators/login { name: 'kassa1', pin: '1234' } -> get token
6. Use token in Authorization header for /api/stamps and /api/redeem

Limitations:
- Operators are stored in server/db.json (pinHash), tokens are stored in db.json too (simple storage). For production: move to a proper DB and use secure secret storage.
- No rate-limiting implemented.
