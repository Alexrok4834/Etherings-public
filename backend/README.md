# EtheRings Alpha Backend Modules

Curated public export of the isolated Alpha modules used to prove verified-email accounts, wallet binding, ERU signed intents/reconciliation, hybrid ERT reservations, and Silver first-entry/chain projection.

The current production MVP backend is not published here and is not modified by this mirror.

## Tests

~~~bash
npm ci
export ALPHA_TEST_DATABASE_URL='postgresql://postgres:postgres@127.0.0.1:5432/etherings_alpha_test'
npm test
npm run build
~~~

Use only a disposable PostgreSQL database.

Runtime configuration is environment-only. No private RPC URL, API key or production database value is included here.
