import { getPairingTokenPath, loadPairingToken } from "./auth.js";

const token = loadPairingToken();
const source = process.env.ALLOY_MCP_TOKEN ? "ALLOY_MCP_TOKEN" : getPairingTokenPath();

console.log("Alloy MCP pairing token:");
console.log(token);
console.log(`\nSource: ${source}`);
console.log("Paste this token into the Alloy MCP extension popup.");