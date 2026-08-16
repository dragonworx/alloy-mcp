import { getPairingTokenPath, loadPairingToken } from "./auth.js";

const token = loadPairingToken();
const source = process.env.CHROME_MCP_TOKEN ? "CHROME_MCP_TOKEN" : getPairingTokenPath();

console.log("Chrome MCP pairing token:");
console.log(token);
console.log(`\nSource: ${source}`);
console.log("Paste this token into the Chrome MCP extension popup.");