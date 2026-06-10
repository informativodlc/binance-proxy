const express = require('express')
const crypto  = require('crypto')
const https   = require('https')

const app = express()
const PORT = process.env.PORT || 3000
const BASE = 'https://fapi.binance.com'

// ── Caché en memoria ──────────────────────────────────────────
const CACHE_TTL = 90 * 1000 // 90 segundos para servir desde caché
const POLL_INTERVAL = 60 * 1000 // 60 segundos entre actualizaciones

const cache = { position: null, price: {} }
const cacheTimestamp = { position: 0, price: {} }

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

// ── Helpers para construir el objeto position normalizado ─────
function normalizePosition(positions, account) {
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

  return {
    openPositions,
    availableBalance,
    walletBalance,
    totalUnrealizedPnl: parseFloat(account.totalUnrealizedProfit || 0),
  }
}

// ── Polling automático ────────────────────────────────────────
async function updateCache() {
  const apiKey = process.env.BINANCE_API_KEY
  const secret = process.env.BINANCE_SECRET_KEY

  const now = Date.now()
  let posOk = false
  let priceOk = false

  // Actualizar posición
  if (apiKey && secret) {
    try {
      const [positions, account] = await Promise.all([
        binanceFetch('/fapi/v2/positionRisk', apiKey, secret),
        binanceFetch('/fapi/v2/account',      apiKey, secret),
      ])
      cache.position = normalizePosition(positions, account)
      cacheTimestamp.position = now
      posOk = true
    } catch (e) {
      console.error('Error actualizando cache (position):', e.message)
    }
  }

  // Actualizar precio BTCUSDT
  try {
    const data = await binanceFetchPublic('/fapi/v1/ticker/price?symbol=BTCUSDT')
    cache.price['BTCUSDT'] = { symbol: data.symbol, price: parseFloat(data.price) }
    cacheTimestamp.price['BTCUSDT'] = now
    priceOk = true
  } catch (e) {
    console.error('Error actualizando cache (price):', e.message)
  }

  if (posOk || priceOk) {
    console.log(`Cache actualizado: ${new Date(now).toISOString()} (position:${posOk} price:${priceOk})`)
  }
}

// Arrancar polling al iniciar el servidor
setInterval(updateCache, POLL_INTERVAL)
updateCache() // primera actualización inmediata

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

  return null
}

// ── GET /health ───────────────────────────────────────────────
app.get('/health', (_req, res) => {
  res.json({ status: 'ok', time: new Date().toISOString() })
})

// ── GET /cache-status ─────────────────────────────────────────
app.get('/cache-status', (_req, res) => {
  const now = Date.now()
  const posAge   = cacheTimestamp.position ? Math.floor((now - cacheTimestamp.position) / 1000) : null
  const priceAge = cacheTimestamp.price['BTCUSDT'] ? Math.floor((now - cacheTimestamp.price['BTCUSDT']) / 1000) : null
  const lastTs   = Math.max(cacheTimestamp.position || 0, cacheTimestamp.price['BTCUSDT'] || 0)
  res.json({
    position_age_seconds:  posAge,
    price_age_seconds:     priceAge,
    last_updated:          lastTs ? new Date(lastTs).toISOString() : null,
  })
})

// ── GET /position ─────────────────────────────────────────────
app.get('/position', async (req, res) => {
  const apiKey = process.env.BINANCE_API_KEY
  const secret = process.env.BINANCE_SECRET_KEY

  if (!apiKey || !secret) {
    return res.status(500).json({ error: 'Binance keys not configured' })
  }

  const now = Date.now()
  const age = now - cacheTimestamp.position

  // Servir desde caché si existe y tiene menos de 90s
  if (cache.position && age < CACHE_TTL) {
    res.setHeader('X-Cache', 'HIT')
    return res.json(cache.position)
  }

  // MISS: llamar a Binance directo
  res.setHeader('X-Cache', 'MISS')
  try {
    const [positions, account] = await Promise.all([
      binanceFetch('/fapi/v2/positionRisk', apiKey, secret),
      binanceFetch('/fapi/v2/account',      apiKey, secret),
    ])
    const normalized = normalizePosition(positions, account)
    cache.position = normalized
    cacheTimestamp.position = now
    return res.json(normalized)
  } catch (e) {
    console.error('[/position]', e.message)
    return res.status(500).json({ error: e.message })
  }
})

// ── GET /price/:symbol ────────────────────────────────────────
app.get('/price/:symbol', async (req, res) => {
  const symbol = (req.params.symbol || '').toUpperCase()
  if (!symbol) return res.status(400).json({ error: 'symbol requerido' })

  const now = Date.now()
  const cachedTs = cacheTimestamp.price[symbol] || 0
  const age = now - cachedTs

  // Servir desde caché si existe y tiene menos de 90s
  if (cache.price[symbol] && age < CACHE_TTL) {
    res.setHeader('X-Cache', 'HIT')
    return res.json(cache.price[symbol])
  }

  // MISS: llamar a Binance directo
  res.setHeader('X-Cache', 'MISS')
  try {
    const data = await binanceFetchPublic(`/fapi/v1/ticker/price?symbol=${symbol}`)
    const result = { symbol: data.symbol, price: parseFloat(data.price) }
    cache.price[symbol] = result
    cacheTimestamp.price[symbol] = now
    return res.json(result)
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

  const sym = symbol.toUpperCase()
  const qty = Math.round(parseFloat(quantity) * 1000) / 1000
  if (qty === 0) {
    return res.status(400).json({ error: 'Balance insuficiente para el tamaño mínimo de orden en BTCUSDT (mínimo 0.001 BTC)' })
  }

  let params = `symbol=${sym}&side=${side}&type=${type}&quantity=${qty}`
  if (type === 'LIMIT') params += `&price=${price}&timeInForce=GTC`
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

  const sym = symbol.toUpperCase()
  const qty = Math.round(parseFloat(quantity) * 1000) / 1000
  if (qty === 0) {
    return res.status(400).json({ error: 'Balance insuficiente para el tamaño mínimo de orden en BTCUSDT (mínimo 0.001 BTC)' })
  }

  const params = `symbol=${sym}&side=${side}&type=STOP_MARKET&stopPrice=${stopPrice}&quantity=${qty}&closePosition=false`

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
