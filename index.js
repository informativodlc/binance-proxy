const express = require('express')
const crypto  = require('crypto')
const https   = require('https')

const app = express()
const PORT = process.env.PORT || 3000
const BASE = 'https://fapi.binance.com'

// ── Body parsing ──────────────────────────────────────────────
app.use(express.json())

// ── CORS ─────────────────────────────────────────────────────
app.use((req, res, next) => {
  const allowed = [
    'https://propuesta-en-proceso.vercel.app',
    'http://localhost:5173',
    'http://localhost:3000',
  ]
  const origin = req.headers.origin
  if (allowed.includes(origin)) res.setHeader('Access-Control-Allow-Origin', origin)
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')
  if (req.method === 'OPTIONS') return res.sendStatus(204)
  next()
})

// ── Helpers ───────────────────────────────────────────────────
function sign(queryString, secret) {
  return crypto.createHmac('sha256', secret).update(queryString).digest('hex')
}

// GET autenticado a Binance Futures
function binanceFetch(path, apiKey, secret) {
  return new Promise((resolve, reject) => {
    const params = `timestamp=${Date.now()}&recvWindow=5000`
    const signature = sign(params, secret)
    const url = `${BASE}${path}?${params}&signature=${signature}`

    https.get(url, { headers: { 'X-MBX-APIKEY': apiKey } }, (res) => {
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

// GET público a Binance (sin firma)
function binanceFetchPublic(path) {
  return new Promise((resolve, reject) => {
    https.get(`${BASE}${path}`, (res) => {
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

// POST autenticado a Binance Futures
function binancePost(path, params, apiKey, secret) {
  return new Promise((resolve, reject) => {
    const fullParams = `${params}&timestamp=${Date.now()}&recvWindow=5000`
    const signature  = sign(fullParams, secret)
    const body       = `${fullParams}&signature=${signature}`

    const options = {
      method:   'POST',
      hostname: 'fapi.binance.com',
      path:     path,
      headers:  {
        'X-MBX-APIKEY':  apiKey,
        'Content-Type':  'application/x-www-form-urlencoded',
        'Content-Length': Buffer.byteLength(body),
      },
    }

    const req = https.request(options, (res) => {
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
    })
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

// Obtener precio actual de mercado (sin autenticación)
async function getMarketPrice(symbol) {
  const data = await binanceFetchPublic(`/fapi/v1/ticker/price?symbol=${symbol}`)
  return parseFloat(data.price)
}

// ── Validaciones de seguridad comunes ─────────────────────────
async function validarOrden({ symbol, side, type, quantity, price, stopPrice, availableBalance }) {
  const SIDES_VALIDOS = ['BUY', 'SELL']
  const TYPES_VALIDOS = ['LIMIT', 'MARKET', 'STOP_MARKET']

  if (!SIDES_VALIDOS.includes(side)) {
    return `side inválido: "${side}". Solo se acepta BUY o SELL.`
  }
  if (!TYPES_VALIDOS.includes(type)) {
    return `type inválido: "${type}". Solo se acepta LIMIT, MARKET o STOP_MARKET.`
  }

  const qty = parseFloat(quantity)
  if (!qty || qty <= 0) {
    return 'quantity debe ser un número positivo mayor que 0.'
  }

  const marketPrice = await getMarketPrice(symbol)
  const MIN_FACTOR  = 0.5
  const MAX_FACTOR  = 2.0

  if (price != null) {
    const p = parseFloat(price)
    if (p <= 0) return 'price debe ser mayor que 0.'
    if (p < marketPrice * MIN_FACTOR || p > marketPrice * MAX_FACTOR) {
      return `price $${p} fuera del rango permitido ($${(marketPrice * MIN_FACTOR).toFixed(2)} – $${(marketPrice * MAX_FACTOR).toFixed(2)}).`
    }
    // Valor nocional vs balance disponible
    const nocional = qty * p
    if (availableBalance != null && nocional > availableBalance * 0.95) {
      return `Valor nocional $${nocional.toFixed(2)} supera el 95% del balance disponible ($${(availableBalance * 0.95).toFixed(2)}).`
    }
  }

  if (stopPrice != null) {
    const sp = parseFloat(stopPrice)
    if (sp <= 0) return 'stopPrice debe ser mayor que 0.'
    if (sp < marketPrice * MIN_FACTOR || sp > marketPrice * MAX_FACTOR) {
      return `stopPrice $${sp} fuera del rango permitido ($${(marketPrice * MIN_FACTOR).toFixed(2)} – $${(marketPrice * MAX_FACTOR).toFixed(2)}).`
    }
  }

  return null // sin errores
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
        symbol:           p.symbol,
        side:             parseFloat(p.positionAmt) > 0 ? 'Long' : 'Short',
        size:             Math.abs(parseFloat(p.positionAmt)),
        entryPrice:       parseFloat(p.entryPrice),
        markPrice:        parseFloat(p.markPrice),
        unrealizedPnl:    parseFloat(p.unRealizedProfit),
        leverage:         parseInt(p.leverage),
        liquidationPrice: parseFloat(p.liquidationPrice),
      }))

    const usdtAsset        = account.assets?.find(a => a.asset === 'USDT')
    const availableBalance = parseFloat(account.availableBalance   || usdtAsset?.availableBalance || 0)
    const walletBalance    = parseFloat(account.totalWalletBalance  || usdtAsset?.walletBalance    || 0)

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

// ── GET /price/:symbol ────────────────────────────────────────
app.get('/price/:symbol', async (req, res) => {
  const symbol = (req.params.symbol || '').toUpperCase()
  if (!symbol) return res.status(400).json({ error: 'symbol requerido' })

  try {
    const data = await binanceFetchPublic(`/fapi/v1/ticker/price?symbol=${symbol}`)
    return res.json({ symbol: data.symbol, price: parseFloat(data.price) })
  } catch (e) {
    console.error('[/price]', e.message)
    return res.status(500).json({ error: e.message })
  }
})

// ── POST /order ───────────────────────────────────────────────
app.post('/order', async (req, res) => {
  const apiKey = process.env.BINANCE_API_KEY
  const secret = process.env.BINANCE_SECRET_KEY
  if (!apiKey || !secret) {
    return res.status(500).json({ error: 'Binance keys not configured' })
  }

  const { symbol, side, type, quantity, price, stopPrice } = req.body || {}

  if (!symbol || !side || !type || quantity == null) {
    return res.status(400).json({ error: 'Campos requeridos: symbol, side, type, quantity.' })
  }

  // Obtener balance para validación nocional
  let availableBalance = null
  try {
    const account = await binanceFetch('/fapi/v2/account', apiKey, secret)
    const usdtAsset = account.assets?.find(a => a.asset === 'USDT')
    availableBalance = parseFloat(account.availableBalance || usdtAsset?.availableBalance || 0)
  } catch { /* si falla, omitir validación de balance */ }

  const error = await validarOrden({ symbol: symbol.toUpperCase(), side, type, quantity, price, stopPrice, availableBalance })
  if (error) {
    return res.status(400).json({ error: `Validación fallida: ${error}` })
  }

  // Construir parámetros para Binance
  const sym = symbol.toUpperCase()
  let params = `symbol=${sym}&side=${side}&type=${type}&quantity=${quantity}`
  if (price      != null) params += `&price=${price}&timeInForce=GTC`
  if (stopPrice  != null) params += `&stopPrice=${stopPrice}`

  try {
    const result = await binancePost('/fapi/v1/order', params, apiKey, secret)
    console.log('[/order] OK', sym, side, type, quantity)
    return res.json(result)
  } catch (e) {
    console.error('[/order]', e.message)
    return res.status(500).json({ error: e.message })
  }
})

// ── POST /order/stop ──────────────────────────────────────────
app.post('/order/stop', async (req, res) => {
  const apiKey = process.env.BINANCE_API_KEY
  const secret = process.env.BINANCE_SECRET_KEY
  if (!apiKey || !secret) {
    return res.status(500).json({ error: 'Binance keys not configured' })
  }

  const { symbol, side, stopPrice, quantity } = req.body || {}

  if (!symbol || !side || stopPrice == null || quantity == null) {
    return res.status(400).json({ error: 'Campos requeridos: symbol, side, stopPrice, quantity.' })
  }

  const error = await validarOrden({
    symbol: symbol.toUpperCase(),
    side,
    type: 'STOP_MARKET',
    quantity,
    stopPrice,
  })
  if (error) {
    return res.status(400).json({ error: `Validación fallida: ${error}` })
  }

  const sym    = symbol.toUpperCase()
  const params = `symbol=${sym}&side=${side}&type=STOP_MARKET&stopPrice=${stopPrice}&quantity=${quantity}&closePosition=false`

  try {
    const result = await binancePost('/fapi/v1/order', params, apiKey, secret)
    console.log('[/order/stop] OK', sym, side, stopPrice)
    return res.json(result)
  } catch (e) {
    console.error('[/order/stop]', e.message)
    return res.status(500).json({ error: e.message })
  }
})

app.listen(PORT, () => console.log(`binance-proxy listening on port ${PORT}`))
