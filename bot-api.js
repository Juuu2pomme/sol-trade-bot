require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { SolanaTracker } = require("solana-swap");
const { Keypair, PublicKey, Connection } = require("@solana/web3.js");
const { Client } = require("@solana-tracker/data-api");
const bs58 = require("bs58").default || require("bs58");
const winston = require("winston");
const fs = require("fs").promises;
const path = require("path");

// ═══════════════════════════════════════════════════════
// CONFIGURATION
// ═══════════════════════════════════════════════════════

const app = express();
app.use(express.json());
app.use(cors());
app.use(express.static('public'));

const PORT = process.env.BOT_PORT || 3001;
const API_KEY = process.env.BOT_API_KEY;

// Logger configuration
const logger = winston.createLogger({
  level: process.env.LOG_LEVEL || "info",
  format: winston.format.combine(
    winston.format.timestamp({ format: "YYYY-MM-DD HH:mm:ss" }),
    winston.format.printf(info => {
      const emoji = {
        error: "❌",
        warn: "⚠️",
        info: "ℹ️",
        debug: "🔍"
      }[info.level] || "";
      return `${info.timestamp} ${emoji} ${info.level.toUpperCase()}: ${info.message}`;
    })
  ),
  transports: [
    new winston.transports.Console({
      format: winston.format.colorize({ all: true })
    }),
    new winston.transports.File({ 
      filename: "bot.log",
      maxsize: 10000000, // 10MB
      maxFiles: 5
    }),
    new winston.transports.File({ 
      filename: "bot-error.log", 
      level: "error",
      maxsize: 10000000,
      maxFiles: 3
    })
  ]
});

// ═══════════════════════════════════════════════════════
// TRADING BOT CLASS
// ═══════════════════════════════════════════════════════

class TradingBot {
  constructor() {
    this.config = this.loadConfig();
    this.positions = new Map();
    this.soldPositions = [];
    this.positionsHistory = new Map(); // Track ATH, entry time, etc.
    this.SOL_ADDRESS = "So11111111111111111111111111111111111111112";
    
    // Stats
    this.stats = {
      startTime: Date.now(),
      totalBuys: 0,
      successfulBuys: 0,
      totalSells: 0,
      successfulSells: 0,
      totalPnL: 0,
      totalVolume: 0
    };
    
    this.init();
  }

  async init() {
    try {
      logger.info("🚀 Initializing Trading Bot...");
      
      // Initialize Solana
      this.keypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
      this.connection = new Connection(this.config.rpcUrl, { 
        commitment: 'confirmed',
        confirmTransactionInitialTimeout: 60000 
      });
      this.solanaTracker = new SolanaTracker(this.keypair, this.config.rpcUrl);
      this.dataClient = new Client({ apiKey: process.env.SOLANA_TRACKER_API_KEY });
      
      logger.info(`📱 Wallet: ${this.keypair.publicKey.toBase58()}`);
      
      // Load saved data
      await this.loadPositions();
      await this.loadSoldPositions();
      
      // Check balance
      await this.checkBalance();
      
      // Start monitoring
      this.startMonitoring();
      
      logger.info("✅ Bot initialized successfully");
      this.logConfig();
      
    } catch (error) {
      logger.error(`Failed to initialize bot: ${error.message}`);
      process.exit(1);
    }
  }

  loadConfig() {
    // Parse trailing stops from env
    const trailingStops = process.env.TRAILING_STOPS
      .split(',')
      .map(pair => {
        const [threshold, stop] = pair.split(':').map(Number);
        return { threshold, stop };
      })
      .sort((a, b) => a.threshold - b.threshold);

    // Parse TTL config
    const ttlConfig = process.env.TTL_CONFIG
      .split(',')
      .map(pair => {
        const [hours, minPnL] = pair.split(':').map(Number);
        return { hours, minPnL };
      })
      .sort((a, b) => a.hours - b.hours);

    return {
      amount: parseFloat(process.env.AMOUNT),
      slippage: parseInt(process.env.SLIPPAGE),
      priorityFee: parseFloat(process.env.PRIORITY_FEE),
      hardStop: parseFloat(process.env.HARD_STOP),
      maxPositions: parseInt(process.env.MAX_POSITIONS),
      rpcUrl: process.env.RPC_URL,
      trailingStops,
      ttlConfig,
      
      // Dead-coin exits
      earlyExit: {
        time: parseInt(process.env.EARLY_EXIT_TIME),
        pnlMin: parseFloat(process.env.EARLY_EXIT_PNL_MIN),
        volume: parseFloat(process.env.EARLY_EXIT_VOLUME),
        pnlMax: parseFloat(process.env.EARLY_EXIT_PNL_MAX)
      },
      drawdownExit: {
        threshold: parseFloat(process.env.DRAWDOWN_THRESHOLD),
        rebound: parseFloat(process.env.DRAWDOWN_REBOUND),
        time: parseInt(process.env.DRAWDOWN_TIME),
        pnlMax: parseFloat(process.env.DRAWDOWN_PNL_MAX)
      },
      volumeExit: {
        threshold: parseFloat(process.env.VOLUME_THRESHOLD),
        pnlMax: parseFloat(process.env.VOLUME_PNL_MAX),
        time: parseInt(process.env.VOLUME_TIME)
      },
      
      monitorInterval: parseInt(process.env.MONITOR_INTERVAL)
    };
  }

  logConfig() {
    logger.info("📋 Configuration:");
    logger.info(`  Amount per trade: ${this.config.amount} SOL`);
    logger.info(`  Max positions: ${this.config.maxPositions}`);
    logger.info(`  Hard stop: ${this.config.hardStop}%`);
    logger.info(`  Trailing stops: ${this.config.trailingStops.length} levels`);
    logger.info(`  Monitor interval: ${this.config.monitorInterval}ms`);
  }

  async checkBalance() {
    try {
      const balance = await this.connection.getBalance(this.keypair.publicKey);
      const solBalance = balance / 1e9;
      logger.info(`💰 Balance: ${solBalance.toFixed(4)} SOL`);
      
      if (solBalance < this.config.amount * 2) {
        logger.warn(`⚠️ Low balance! Need at least ${this.config.amount * 2} SOL`);
      }
    } catch (error) {
      logger.error(`Failed to check balance: ${error.message}`);
    }
  }

  // ═══════════════════════════════════════════════════════
  // BUY HANDLER (Called by n8n webhook)
  // ═══════════════════════════════════════════════════════

  async handleBuySignal(tokenAddress, metadata = {}) {
    try {
      logger.info(`\n🔔 BUY SIGNAL received for ${tokenAddress}`);
      
      // Validations
      if (this.positions.has(tokenAddress)) {
        return { success: false, reason: "Already in position" };
      }
      
      if (this.positions.size >= this.config.maxPositions) {
        return { success: false, reason: "Max positions reached" };
      }
      
      // Fetch token data
      logger.info("📊 Fetching token data...");
      const tokenData = await this.dataClient.getTokenInfo(tokenAddress);
      
      if (!tokenData || !tokenData.pools || tokenData.pools.length === 0) {
        return { success: false, reason: "Token data not available" };
      }
      
      // Execute buy
      this.stats.totalBuys++;
      const result = await this.executeBuy(tokenData, metadata);
      
      if (result.success) {
        this.stats.successfulBuys++;
      }
      
      return result;
      
    } catch (error) {
      logger.error(`❌ Buy signal error: ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  async executeBuy(tokenData, metadata) {
    const tokenMint = tokenData.token.mint;
    const symbol = tokenData.token.symbol;
    const entryPrice = tokenData.pools[0].price.usd;
    
    try {
      logger.info(`🛒 Executing BUY: ${symbol} @ $${entryPrice}`);
      
      // Get swap instructions
      const swapResponse = await this.solanaTracker.getSwapInstructions(
        this.SOL_ADDRESS,
        tokenMint,
        this.config.amount,
        this.config.slippage,
        this.keypair.publicKey.toBase58(),
        this.config.priorityFee
      );
      
      // Execute transaction
      const txid = await this.solanaTracker.performSwap(swapResponse, {
        sendOptions: { skipPreflight: true },
        confirmationRetries: 30,
        confirmationRetryTimeout: 1000,
        commitment: "confirmed"
      });
      
      logger.info(`📤 Transaction sent: ${txid}`);
      
      // Wait and verify balance
      await this.sleep(5000);
      const balance = await this.getTokenBalance(tokenMint);
      
      if (!balance || balance === 0) {
        throw new Error("Failed to confirm token balance");
      }
      
      // Save position
      const position = {
        tokenMint,
        symbol,
        name: tokenData.token.name,
        entryPrice,
        entryTime: Date.now(),
        amount: balance,
        investment: this.config.amount,
        txid,
        metadata,
        market: tokenData.pools[0].market,
        liquidity: tokenData.pools[0].liquidity?.usd || 0,
        marketCap: tokenData.pools[0].marketCap?.usd || 0,
      };
      
      // Initialize position tracking
      this.positionsHistory.set(tokenMint, {
        ath: entryPrice,
        athTime: Date.now(),
        lastPrice: entryPrice,
        lastVolume: tokenData.pools[0].volume24h?.usd || 0,
        volumeHistory: [],
        priceHistory: [],
        drawdownStart: null,
        lowVolumeStart: null
      });
      
      this.positions.set(tokenMint, position);
      await this.savePositions();
      
      this.stats.totalVolume += this.config.amount;
      
      logger.info(`✅ BUY SUCCESS: ${symbol}`);
      logger.info(`   Amount: ${balance.toFixed(2)} tokens`);
      logger.info(`   Value: $${(balance * entryPrice).toFixed(2)}`);
      
      return {
        success: true,
        position,
        txid
      };
      
    } catch (error) {
      logger.error(`❌ BUY FAILED: ${symbol} - ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // ═══════════════════════════════════════════════════════
  // MONITORING LOOP (Autonomous)
  // ═══════════════════════════════════════════════════════

  startMonitoring() {
    logger.info("📊 Starting autonomous monitoring...");
    
    setInterval(async () => {
      if (this.positions.size === 0) return;
      
      logger.debug(`Monitoring ${this.positions.size} positions...`);
      
      for (const [tokenMint, position] of this.positions) {
        await this.checkPosition(tokenMint);
      }
      
    }, this.config.monitorInterval);
    
    // Stats display every 5 minutes
    setInterval(() => {
      if (this.positions.size > 0) {
        this.displayStats();
      }
    }, 300000);
  }

  async checkPosition(tokenMint) {
    try {
      const position = this.positions.get(tokenMint);
      const history = this.positionsHistory.get(tokenMint);
      
      // Fetch current data
      const tokenData = await this.dataClient.getTokenInfo(tokenMint);
      
      if (!tokenData || !tokenData.pools || tokenData.pools.length === 0) {
        logger.warn(`No data for ${position.symbol}, skipping check`);
        return;
      }
      
      const currentPrice = tokenData.pools[0].price.usd;
      const currentVolume = tokenData.pools[0].volume24h?.usd || 0;
      const pnlPercentage = ((currentPrice - position.entryPrice) / position.entryPrice) * 100;
      const holdTimeMinutes = Math.floor((Date.now() - position.entryTime) / 60000);
      
      // Update history
      history.lastPrice = currentPrice;
      history.lastVolume = currentVolume;
      history.priceHistory.push({ time: Date.now(), price: currentPrice });
      history.volumeHistory.push({ time: Date.now(), volume: currentVolume });
      
      // Keep only last 30 data points
      if (history.priceHistory.length > 30) history.priceHistory.shift();
      if (history.volumeHistory.length > 30) history.volumeHistory.shift();
      
      // Update ATH
      if (currentPrice > history.ath) {
        history.ath = currentPrice;
        history.athTime = Date.now();
        logger.debug(`${position.symbol} new ATH: $${currentPrice.toFixed(8)} (+${pnlPercentage.toFixed(2)}%)`);
      }
      
      // Calculate metrics
      const drawdownFromATH = ((currentPrice - history.ath) / history.ath) * 100;
      const avgVolume = history.volumeHistory.reduce((sum, v) => sum + v.volume, 0) / history.volumeHistory.length;
      
      // Check ALL exit conditions
      const exitCheck = this.checkExitConditions(
        position,
        history,
        currentPrice,
        pnlPercentage,
        drawdownFromATH,
        currentVolume,
        avgVolume,
        holdTimeMinutes
      );
      
      if (exitCheck.shouldExit) {
        logger.info(`🎯 EXIT TRIGGER: ${position.symbol} - ${exitCheck.reason}`);
        logger.info(`   PnL: ${pnlPercentage.toFixed(2)}% | Hold: ${holdTimeMinutes}min`);
        
        this.stats.totalSells++;
        const sellResult = await this.executeSell(tokenData);
        
        if (sellResult.success) {
          this.stats.successfulSells++;
        }
      }
      
    } catch (error) {
      logger.error(`Error checking ${tokenMint}: ${error.message}`);
    }
  }

  checkExitConditions(position, history, currentPrice, pnlPercentage, drawdownFromATH, currentVolume, avgVolume, holdTimeMinutes) {
    // 1. HARD STOP (-25%)
    if (pnlPercentage <= this.config.hardStop) {
      return { shouldExit: true, reason: `Hard stop (${pnlPercentage.toFixed(2)}%)` };
    }
    
    // 2. TRAILING STOP
    const trailingStop = this.getTrailingStop(pnlPercentage);
    if (trailingStop !== null && pnlPercentage <= trailingStop) {
      return { shouldExit: true, reason: `Trailing stop (${pnlPercentage.toFixed(2)}% ≤ ${trailingStop}%)` };
    }
    
    // 3. EARLY EXIT (15 min check)
    if (holdTimeMinutes >= 15 && holdTimeMinutes <= 20) {
      if (pnlPercentage < this.config.earlyExit.pnlMin && 
          currentVolume < this.config.earlyExit.volume &&
          pnlPercentage > this.config.earlyExit.pnlMax) {
        return { shouldExit: true, reason: `Early exit - dead coin (15min, PnL: ${pnlPercentage.toFixed(2)}%)` };
      }
    }
    
    // 4. DRAWDOWN EXIT
    if (drawdownFromATH <= -this.config.drawdownExit.threshold && pnlPercentage < this.config.drawdownExit.pnlMax) {
      if (!history.drawdownStart) {
        history.drawdownStart = Date.now();
      } else {
        const drawdownDuration = Date.now() - history.drawdownStart;
        
        // Check for rebound
        const recentPrices = history.priceHistory.slice(-3);
        const hasRebound = recentPrices.some(p => {
          const reboundPct = ((p.price - currentPrice) / currentPrice) * 100;
          return reboundPct > this.config.drawdownExit.rebound;
        });
        
        if (!hasRebound && drawdownDuration >= this.config.drawdownExit.time) {
          return { shouldExit: true, reason: `Drawdown exit (${drawdownFromATH.toFixed(2)}% drop, no rebound)` };
        }
      }
    } else {
      history.drawdownStart = null;
    }
    
    // 5. VOLUME DEATH EXIT
    const volumeRatio = avgVolume > 0 ? (currentVolume / avgVolume) * 100 : 100;
    if (volumeRatio < this.config.volumeExit.threshold && pnlPercentage < this.config.volumeExit.pnlMax) {
      if (!history.lowVolumeStart) {
        history.lowVolumeStart = Date.now();
      } else {
        const lowVolumeDuration = Date.now() - history.lowVolumeStart;
        if (lowVolumeDuration >= this.config.volumeExit.time) {
          return { shouldExit: true, reason: `Volume death (${volumeRatio.toFixed(0)}% of avg, PnL: ${pnlPercentage.toFixed(2)}%)` };
        }
      }
    } else {
      history.lowVolumeStart = null;
    }
    
    // 6. TTL (Time To Live) - Conditional
    const holdTimeHours = holdTimeMinutes / 60;
    for (const ttl of this.config.ttlConfig) {
      if (holdTimeHours >= ttl.hours && pnlPercentage < ttl.minPnL) {
        return { shouldExit: true, reason: `TTL exit (${holdTimeHours.toFixed(1)}h, PnL: ${pnlPercentage.toFixed(2)}% < ${ttl.minPnL}%)` };
      }
    }
    
    return { shouldExit: false };
  }

  getTrailingStop(pnlPercentage) {
    for (let i = this.config.trailingStops.length - 1; i >= 0; i--) {
      const { threshold, stop } = this.config.trailingStops[i];
      if (pnlPercentage >= threshold) {
        return stop;
      }
    }
    return null;
  }

  async executeSell(tokenData) {
    const tokenMint = tokenData.token.mint;
    const position = this.positions.get(tokenMint);
    
    try {
      logger.info(`🔴 Executing SELL: ${position.symbol}`);
      
      const swapResponse = await this.solanaTracker.getSwapInstructions(
        tokenMint,
        this.SOL_ADDRESS,
        position.amount,
        this.config.slippage,
        this.keypair.publicKey.toBase58(),
        this.config.priorityFee
      );
      
      const txid = await this.solanaTracker.performSwap(swapResponse, {
        sendOptions: { skipPreflight: true },
        confirmationRetries: 30,
        commitment: "confirmed"
      });
      
      const exitPrice = tokenData.pools[0].price.usd;
      const pnl = (exitPrice - position.entryPrice) * position.amount;
      const pnlPercentage = ((exitPrice - position.entryPrice) / position.entryPrice) * 100;
      const holdTime = Math.floor((Date.now() - position.entryTime) / 60000);
      
      const soldPosition = {
        ...position,
        exitPrice,
        exitTime: Date.now(),
        pnl,
        pnlPercentage,
        holdTime,
        closeTxid: txid,
        ath: this.positionsHistory.get(tokenMint).ath
      };
      
      this.soldPositions.push(soldPosition);
      this.stats.totalPnL += pnl;
      this.stats.totalVolume += pnl;
      
      this.positions.delete(tokenMint);
      this.positionsHistory.delete(tokenMint);
      
      await this.savePositions();
      await this.saveSoldPositions();
      
      const emoji = pnl >= 0 ? "🟢" : "🔴";
      logger.info(`${emoji} SELL SUCCESS: ${position.symbol}`);
      logger.info(`   Exit: $${exitPrice.toFixed(8)}`);
      logger.info(`   PnL: $${pnl.toFixed(2)} (${pnlPercentage.toFixed(2)}%)`);
      logger.info(`   Hold: ${holdTime}min`);
      
      return { success: true, soldPosition, txid };
      
    } catch (error) {
      logger.error(`❌ SELL FAILED: ${position.symbol} - ${error.message}`);
      return { success: false, error: error.message };
    }
  }

  // ═══════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════

async getTokenBalance(mint, retries = 5) {
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const tokenAccounts = await this.connection.getTokenAccountsByOwner(
        this.keypair.publicKey,
        { mint: new PublicKey(mint) },
        { commitment: 'confirmed' }
      );
      
      if (tokenAccounts.value.length > 0) {
        const accountInfo = await this.connection.getTokenAccountBalance(
          tokenAccounts.value[0].pubkey,
          'confirmed'
        );
        
        const balance = accountInfo.value.uiAmount;
        if (balance && balance > 0) {
          logger.info(`✅ Balance verified: ${balance.toFixed(2)} tokens`);
          return balance;
        }
      }
      
      if (attempt < retries) {
        const waitTime = 3000 * (attempt + 1);
        logger.warn(`⏳ Attempt ${attempt + 1}/${retries} - No balance yet, waiting ${waitTime}ms...`);
        await this.sleep(waitTime);
      }
      
    } catch (error) {
      logger.error(`Attempt ${attempt + 1}/${retries} failed: ${error.message}`);
      
      if (error.message.includes('JSON') || error.message.includes('parse')) {
        logger.warn(`JSON parsing error detected, will retry...`);
      }
      
      if (attempt < retries) {
        await this.sleep(3000 * (attempt + 1));
      } else {
        throw new Error(`Failed to verify balance after ${retries} attempts`);
      }
    }
  }
  
  return null;
}

  sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  async loadPositions() {
    try {
      const data = await fs.readFile("positions.json", "utf8");
      const loaded = JSON.parse(data);
      this.positions = new Map(Object.entries(loaded));
      logger.info(`📂 Loaded ${this.positions.size} active positions`);
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.error(`Error loading positions: ${error.message}`);
      }
    }
  }

  async savePositions() {
    const obj = Object.fromEntries(this.positions);
    await fs.writeFile("positions.json", JSON.stringify(obj, null, 2));
  }

  async loadSoldPositions() {
    try {
      const data = await fs.readFile("sold_positions.json", "utf8");
      this.soldPositions = JSON.parse(data);
      this.stats.totalPnL = this.soldPositions.reduce((sum, p) => sum + (p.pnl || 0), 0);
      logger.info(`📂 Loaded ${this.soldPositions.length} trade history`);
    } catch (error) {
      if (error.code !== "ENOENT") {
        logger.error(`Error loading sold positions: ${error.message}`);
      }
    }
  }

  async saveSoldPositions() {
    await fs.writeFile("sold_positions.json", JSON.stringify(this.soldPositions, null, 2));
  }

  displayStats() {
    const runtime = Math.floor((Date.now() - this.stats.startTime) / 60000);
    const winRate = this.stats.totalSells > 0 
      ? (this.soldPositions.filter(p => p.pnl > 0).length / this.stats.totalSells * 100).toFixed(1)
      : 0;
    
    logger.info(`\n📊 Bot Statistics (${runtime}min runtime):`);
    logger.info(`   Active Positions: ${this.positions.size}/${this.config.maxPositions}`);
    logger.info(`   Total PnL: $${this.stats.totalPnL.toFixed(2)}`);
    logger.info(`   Trades: ${this.stats.totalSells} (${this.stats.successfulSells} successful)`);
    logger.info(`   Win Rate: ${winRate}%`);
  }

  // API getters for dashboard
  getPositionsForAPI() {
    return Array.from(this.positions.entries()).map(([mint, pos]) => {
      const history = this.positionsHistory.get(mint);
      const currentPnL = history ? 
        ((history.lastPrice - pos.entryPrice) / pos.entryPrice) * 100 : 0;
      
      return {
        ...pos,
        currentPrice: history?.lastPrice || pos.entryPrice,
        currentPnL,
        ath: history?.ath || pos.entryPrice,
        holdTime: Math.floor((Date.now() - pos.entryTime) / 60000)
      };
    });
  }

  getStats() {
    const runtime = Math.floor((Date.now() - this.stats.startTime) / 60000);
    const wins = this.soldPositions.filter(p => p.pnl > 0).length;
    const losses = this.soldPositions.filter(p => p.pnl <= 0).length;
    
    return {
      ...this.stats,
      runtime,
      wins,
      losses,
      winRate: this.stats.totalSells > 0 ? (wins / this.stats.totalSells * 100).toFixed(1) : 0,
      avgPnL: this.soldPositions.length > 0 
        ? (this.stats.totalPnL / this.soldPositions.length).toFixed(2) 
        : 0
    };
  }
}

// ═══════════════════════════════════════════════════════
// INITIALIZE BOT
// ═══════════════════════════════════════════════════════

const bot = new TradingBot();

// ═══════════════════════════════════════════════════════
// API MIDDLEWARE
// ═══════════════════════════════════════════════════════

function authenticateAPI(req, res, next) {
  const apiKey = req.headers['x-api-key'];
  if (apiKey !== API_KEY) {
    logger.warn(`Unauthorized API attempt from ${req.ip}`);
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ═══════════════════════════════════════════════════════
// API ROUTES
// ═══════════════════════════════════════════════════════

// POST /buy - Receive buy signal from n8n
app.post("/buy", authenticateAPI, async (req, res) => {
  const { tokenAddress, metadata } = req.body;
  
  if (!tokenAddress) {
    return res.status(400).json({ error: "tokenAddress required" });
  }
  
  const result = await bot.handleBuySignal(tokenAddress, metadata);
  res.json(result);
});

// GET /positions - Active positions
app.get("/positions", authenticateAPI, (req, res) => {
  res.json(bot.getPositionsForAPI());
});

// GET /history - Trade history
app.get("/history", authenticateAPI, (req, res) => {
  res.json(bot.soldPositions);
});

// GET /stats - Statistics
app.get("/stats", authenticateAPI, (req, res) => {
  res.json(bot.getStats());
});

// GET /health - Health check
app.get("/health", (req, res) => {
  res.json({ 
    status: "ok", 
    uptime: process.uptime(),
    positions: bot.positions.size 
  });
});

// GET / - Dashboard
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, 'dashboard.html'));
});

// ═══════════════════════════════════════════════════════
// START SERVER
// ═══════════════════════════════════════════════════════

app.listen(PORT, '0.0.0.0', () => {
  logger.info(`🚀 Trading Bot API running on http://127.0.0.1:${PORT}`);
  logger.info(`📊 Dashboard: http://127.0.0.1:${PORT}`);
});

// Graceful shutdown
process.on('SIGINT', async () => {
  logger.info("\n🛑 Shutting down gracefully...");
  await bot.savePositions();
  await bot.saveSoldPositions();
  bot.displayStats();
  process.exit(0);
});
