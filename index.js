const express = require('express')
const crypto  = require('crypto')
const https   = require('https')

const app = express()
const PORT = process.env.PORT || 3000
const BASE = 'https://fapi.binance.com'

// ── CORS ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  const allowed = [
    'https://propuesta-en-proceso.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000',
  ]
  const origin = req.headers.origin
  if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// ── Helpers ───────────────────────────────────────────────────
function sign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex')
}

function binanceFetch(path, apiKey, secret) {
  return new Promise((resolve, reject) => {
    const params = `timestamp=${Date.now()}&recvWindow=5000`
    const signature = sign(params, secret)
    const url = `${BASE}${path}?${params}&signature=${signature}`

    const options = {
      headers: { 'X-MBX-APIKEY': apiKey },
    }

    https.get(url, options, (res) => {
      let data = ''
      res.on('data', chunk => { data += chunk })
      res.on('end', () => {
        try {
          const parsed = JSON.parse(data)
          if (res.statusCode !== 200) {
            reject(new Error(`Binance ${res.statusCode}: ${JSON.stringify(parsed)}`))
          } else {
            resolve(parsed)
          }
        } catch (e) {
          reject(new Error('JSON parse error: ' + data))
        }
      })
    }).on('error', reject)
  })
}

// ── GET /health ───────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() })
})

// ── GET /position ─────────────────────────────────────────────
app.get('/position', async (req, res) => {
  const apiKey = process.env.BINANCE_API_KEY
  const secret = process.env.BINANCE_SECRET_KEY

  if (!apiKey || !secret) {
    return res.status(500).json({ error: 'Binance keys not configured' })
  }

  try {
    const [positions, account] = await Promise.all([
      binanceFetch('/fapi/v2/positionRisk', apiKey, secret),
      binanceFetch('/fapi/v2/account',      apiKey, secret),
    ])

    const openPositions = positions
      .filter(p => parseFloat(p.positionAmt) !== 0)
      .map(p => ({
        symbol:          p.symbol,
        side:            parseFloat(p.positionAmt) > 0 ? 'Long' : 'Short',
        size:            Math.abs(parseFloat(p.positionAmt)),
        entryPrice:      parseFloat(p.entryPrice),
        markPrice:       parseFloat(p.markPrice),
        unrealizedPnl:   parseFloat(p.unRealizedProfit),
        leverage:        parseInt(p.leverage),
        liquidationPrice: parseFloat(p.liquidationPrice),
      }))

    const usdtAsset       = account.assets?.find(a => a.asset === 'USDT')
    const availableBalance = parseFloat(account.availableBalance  || usdtAsset?.availableBalance || 0)
    const walletBalance    = parseFloat(account.totalWalletBalance || usdtAsset?.walletBalance    || 0)

    return res.json({
      openPositions,
      availableBalance,
      walletBalance,
      totalUnrealizedPnl: parseFloat(account.totalUnrealizedProfit || 0),
    })
  } catch (e) {
    console.error('[/position]', e.message)
    return res.status(500).json({ error: e.message })
  }
})

app.listen(PORT, () => console.log(`binance-proxy listening on port ${PORT}`))
