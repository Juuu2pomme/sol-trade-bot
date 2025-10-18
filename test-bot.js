require("dotenv").config();
const { Keypair, Connection } = require("@solana/web3.js");
const { Client } = require("@solana-tracker/data-api");
const bs58 = require("bs58").default || require("bs58");

console.log("\n🧪 === TESTS DU BOT ===\n");

async function runTests() {
  // Test 1 : Variables d'environnement
  console.log("📋 Test 1 : Variables d'environnement");
  const required = ['PRIVATE_KEY', 'RPC_URL', 'SOLANA_TRACKER_API_KEY'];
  let allPresent = true;
  
  required.forEach(v => {
    if (!process.env[v]) {
      console.log(`   ❌ ${v} manquant`);
      allPresent = false;
    } else {
      console.log(`   ✅ ${v} présent`);
    }
  });
  
  if (!allPresent) {
    console.log("\n❌ Vérifie ton .env\n");
    process.exit(1);
  }
  
  // Test 2 : Wallet
  console.log("\n🔑 Test 2 : Wallet");
  try {
    const keypair = Keypair.fromSecretKey(bs58.decode(process.env.PRIVATE_KEY));
    console.log(`   ✅ Wallet: ${keypair.publicKey.toBase58()}`);
    
    // Test 3 : RPC
    console.log("\n🌐 Test 3 : Connexion RPC");
    const connection = new Connection(process.env.RPC_URL);
    const balance = await connection.getBalance(keypair.publicKey);
    const sol = balance / 1e9;
    
    console.log(`   ✅ RPC connecté`);
    console.log(`   💰 Balance: ${sol.toFixed(4)} SOL`);
    
    if (sol < 0.01) {
      console.log(`   ⚠️  Balance faible ! Ajoute au moins 0.01 SOL`);
    }
    
    // Test 4 : API Solana Tracker
    console.log("\n📡 Test 4 : API Solana Tracker");
    const client = new Client({ apiKey: process.env.SOLANA_TRACKER_API_KEY });
    const solToken = "So11111111111111111111111111111111111111112";
    const data = await client.getTokenInfo(solToken);
    
    console.log(`   ✅ API connectée`);
    console.log(`   📊 Prix SOL: $${data.pools[0].price.usd}`);
    
    // Résumé
    console.log("\n✅ TOUS LES TESTS SONT PASSÉS !");
    console.log("\n🚀 Tu peux maintenant lancer le bot avec: npm start\n");
    
  } catch (error) {
    console.log(`\n❌ ERREUR: ${error.message}\n`);
    process.exit(1);
  }
}

runTests();