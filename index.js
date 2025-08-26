// app.js
const fs = require("fs");
const { findTokens } = require("./find");
const { runSwap } = require("./swap");

const command = process.argv[2];

console.log(`\n🔁 PingPong Bot Controller\n==============================`);

switch (command) {
  case "find":
    runFind();
    break;

  case "swap":
    runSwapFromFile();
    break;

  case "run":
    runFind().then(() => runSwapFromFile());
    break;

  default:
    console.log("❓ Unknown command. Usage:");
    console.log("  node app.js find    → Discover trending tokens");
    console.log("  node app.js swap    → Swap using mint from mint.txt");
    console.log("  node app.js run     → Discover + swap top token");
    break;
}

// === Helpers ===

async function runFind() {
  console.log("🔍 Finding top trending tokens...");
  const topMint = await findTokens("v24hChangePercent", true);
  if (topMint) {
    fs.writeFileSync("mint.txt", topMint);
    console.log(`✅ Saved top mint to mint.txt: ${topMint}`);
  } else {
    console.log("❌ No valid token found.");
  }
}

function runSwapFromFile() {
  if (!fs.existsSync("mint.txt")) {
    console.log("❌ mint.txt not found. Run `node app.js find` first.");
    return;
  }

  const mint = fs.readFileSync("mint.txt", "utf8").trim();
  if (!mint) {
    console.log("❌ mint.txt is empty.");
    return;
  }

  console.log(`💰 Swapping token: ${mint}`);
  runSwap(mint);
}
