# binance-proxy

Minimal Node.js/Express server that proxies Binance Futures API calls.

## Endpoints

- `GET /health` — liveness check
- `GET /position` — returns open futures positions + USDT balance

## Environment variables

| Variable | Description |
|---|---|
| `BINANCE_API_KEY` | Your Binance API key (Futures read permission) |
| `BINANCE_SECRET_KEY` | Your Binance secret key |
| `PORT` | Port to listen on (default: 3000) |

## Run locally

```bash
npm install
BINANCE_API_KEY=xxx BINANCE_SECRET_KEY=yyy npm start
```

## Deploy to Railway / Render / Fly.io

Set the two env vars and deploy. The start command is `node index.js`.
