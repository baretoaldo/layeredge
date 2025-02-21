import fs from "fs/promises";
import axios from "axios";
import { Wallet } from "ethers";

// Colors for console output
const colors = {
  reset: "\x1b[0m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  red: "\x1b[31m",
};

const CONFIG = {
  MIN_DELAY_BETWEEN_WALLETS: 5 * 1000,   // 5 seconds minimum
  MAX_DELAY_BETWEEN_WALLETS: 10 * 1000,  // 10 seconds maximum
  RESTART_DELAY: 5 * 60 * 60 * 1000,     // 5 hours
  MAX_RETRIES: 3,                        // Maximum number of retries before removing wallet
};

// Function to get random delay between min and max
const getRandomDelay = () => {
  return Math.floor(
    Math.random() * 
    (CONFIG.MAX_DELAY_BETWEEN_WALLETS - CONFIG.MIN_DELAY_BETWEEN_WALLETS + 1) +
    CONFIG.MIN_DELAY_BETWEEN_WALLETS
  );
};

class WalletDashboard {
  constructor() {
    this.wallets = [];
    this.walletStats = new Map();
    this.privateKeys = new Map();
    this.currentWalletIndex = 0;
    this.isRunning = true;
    this.errorCounts = new Map(); // Track error counts for each wallet
    this.removedWallets = []; // Track removed wallets
  }

  async saveRemovedWallets() {
    try {
      const timestamp = new Date().toISOString().replace(/:/g, '-');
      const content = this.removedWallets.map(wallet => 
        `${wallet.address},${wallet.privateKey},${wallet.reason},${wallet.timestamp}`
      ).join('\n');
      
      await fs.appendFile('removed_wallets.csv', content + '\n');
      console.log(`${colors.yellow}Removed wallets saved to removed_wallets.csv${colors.reset}`);
    } catch (error) {
      console.error(`${colors.red}Error saving removed wallets: ${error.message}${colors.reset}`);
    }
  }

  async removeWallet(wallet, reason) {
    const privateKey = this.privateKeys.get(wallet);
    this.wallets = this.wallets.filter(w => w !== wallet);
    this.privateKeys.delete(wallet);
    this.walletStats.delete(wallet);
    this.errorCounts.delete(wallet);
    
    this.removedWallets.push({
      address: wallet,
      privateKey: privateKey,
      reason: reason,
      timestamp: new Date().toISOString()
    });
    
    await this.saveRemovedWallets();
    console.log(`${colors.red}Removed wallet ${wallet.substr(0, 6)}...${wallet.substr(-4)} due to: ${reason}${colors.reset}`);
  }

  increaseErrorCount(wallet) {
    const currentCount = this.errorCounts.get(wallet) || 0;
    this.errorCounts.set(wallet, currentCount + 1);
    return currentCount + 1;
  }

  async initialize() {
    try {
      const data = await fs.readFile("data.txt", "utf8");
      const privateKeys = data.split("\n").filter((line) => line.trim() !== "");

      this.wallets = [];
      this.privateKeys = new Map();
      this.errorCounts = new Map();

      for (let privateKey of privateKeys) {
        try {
          const wallet = new Wallet(privateKey);
          const address = wallet.address;
          this.wallets.push(address);
          this.privateKeys.set(address, privateKey);

          this.walletStats.set(address, {
            status: "Pending",
            lastPing: "-",
            points: 0,
            error: null,
          });
        } catch (error) {
          console.error(`${colors.red}Invalid private key: ${privateKey} - ${error.message}${colors.reset}`);
        }
      }

      if (this.wallets.length === 0) {
        throw new Error("No valid private keys found in data.txt");
      }
      
      console.log(`${colors.cyan}Successfully loaded ${colors.yellow}${this.wallets.length}${colors.cyan} wallets${colors.reset}`);
    } catch (error) {
      console.error(`${colors.red}Error reading data.txt: ${error}${colors.reset}`);
      process.exit(1);
    }
  }

  // ... [other unchanged methods remain the same]

  async processWallet(wallet) {
    const stats = this.walletStats.get(wallet);
    const walletNum = this.currentWalletIndex + 1;
    const totalWallets = this.wallets.length;
    
    console.log(`\n${colors.cyan}--- Processing wallet ${colors.yellow}${walletNum}/${totalWallets}${colors.cyan}: ${wallet.substr(0, 6)}...${wallet.substr(-4)} ---${colors.reset}`);
    stats.status = "Processing";

    try {
      const privateKey = this.privateKeys.get(wallet);
      if (!privateKey) {
        throw new Error("Private key not found for wallet");
      }

      console.log(`${colors.cyan}Checking status for wallet ${colors.yellow}${walletNum}/${totalWallets}${colors.reset}`);
      stats.status = "Checking Status";
      
      const isRunning = await this.checkNodeStatus(wallet);
      
      if (!isRunning) {
        console.log(`${colors.yellow}Activating wallet ${walletNum}/${totalWallets}${colors.reset}`);
        stats.status = "Activating";
        
        const activated = await this.signAndStart(wallet, privateKey);
        if (!activated) {
          throw new Error("Node activation unsuccessful");
        }
        
        console.log(`${colors.green}Successfully activated wallet ${walletNum}/${totalWallets}${colors.reset}`);
        stats.status = "Activated";
        
        await new Promise((resolve) => setTimeout(resolve, 5000));
      } else {
        console.log(`${colors.green}Wallet ${walletNum}/${totalWallets} is already active${colors.reset}`);
      }

      console.log(`${colors.cyan}Pinging wallet ${colors.yellow}${walletNum}/${totalWallets}${colors.reset}`);
      const result = await this.updatePoints(wallet);
      stats.lastPing = new Date().toLocaleTimeString();
      stats.points = result.nodePoints || stats.points;
      stats.status = "Active";
      stats.error = null;
      this.errorCounts.set(wallet, 0); // Reset error count on success
      
      console.log(`${colors.green}Ping successful for wallet ${walletNum}/${totalWallets}. Current points: ${colors.green}${stats.points}${colors.reset}`);
      
      return true;
    } catch (error) {
      stats.status = "Error";
      stats.error = error.message;
      console.error(`${colors.red}Error processing wallet ${walletNum}/${totalWallets}: ${error.message}${colors.reset}`);
      
      const errorCount = this.increaseErrorCount(wallet);
      if (errorCount >= CONFIG.MAX_RETRIES) {
        await this.removeWallet(wallet, error.message);
        return false;
      }
      
      return false;
    }
  }

  async processAllWallets() {
    while (this.isRunning) {
      for (this.currentWalletIndex = 0; this.currentWalletIndex < this.wallets.length; this.currentWalletIndex++) {
        const wallet = this.wallets[this.currentWalletIndex];
        await this.processWallet(wallet);
        
        if (this.currentWalletIndex < this.wallets.length - 1) {
          const delay = getRandomDelay();
          const delaySeconds = (delay / 1000).toFixed(1);
          console.log(`${colors.cyan}Waiting ${colors.yellow}${delaySeconds}${colors.cyan} seconds before processing next wallet...${colors.reset}`);
          await new Promise(resolve => setTimeout(resolve, delay));
        }
      }
      
      if (this.wallets.length === 0) {
        console.log(`${colors.red}No wallets remaining. Stopping process.${colors.reset}`);
        this.isRunning = false;
        break;
      }
      
      console.log(`\n${colors.green}Completed processing all ${colors.yellow}${this.wallets.length}${colors.green} wallets.${colors.reset}`);
      console.log(`${colors.cyan}Waiting ${colors.yellow}${CONFIG.RESTART_DELAY / 3600000}${colors.cyan} hours before restarting the process...${colors.reset}`);
      await new Promise(resolve => setTimeout(resolve, CONFIG.RESTART_DELAY));
      console.log(`${colors.green}Restarting wallet processing cycle...${colors.reset}`);
    }
  }
}

const dashboard = new WalletDashboard();
dashboard.start().catch((error) => {
  console.error(`${colors.red}Fatal error: ${error}${colors.reset}`);
  process.exit(1);
});
