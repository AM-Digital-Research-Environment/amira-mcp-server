#!/usr/bin/env node
// Personal curator token generator (#26):
//
//   node server/tokenCli.js <name>
//
// Prints a new 256-bit token ONCE, for the curator, and the `name sha256hex`
// line to append to AMIRA_MCP_TOKENS_FILE. Only the hash goes in the file, so
// a lost token cannot be recovered: generate a new one and replace the line.
// Revoke a curator by deleting their line; the server re-reads the file within
// seconds. Nothing is written anywhere by this command.
import { generateToken, hashToken } from "./access.js";

const name = process.argv[2] ?? "";
if (!/^[A-Za-z0-9][A-Za-z0-9._@-]{0,63}$/.test(name)) {
  console.error("usage: node server/tokenCli.js <name>   (letters, digits, . _ @ -; at most 64 characters)");
  console.error("The name identifies the curator in the audit log; use one name per person.");
  process.exit(2);
}
const token = generateToken();
console.log(`Token for ${name} (shown once; hand it to the curator over a private channel):\n\n  ${token}\n`);
console.log(`Add this line to the AMIRA_MCP_TOKENS_FILE (replace any earlier line for ${name}):\n\n${name} ${hashToken(token)}\n`);
console.log(`The curator sends it as "Authorization: Bearer <token>". Delete the line to revoke it.`);
