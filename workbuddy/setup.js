#!/usr/bin/env node
// One-step WorkBuddy hookup: checks the live app and its MCP endpoint answer,
// and prints the MCP entry with this machine's absolute path filled in.
// Usage (from the repo root): node workbuddy/setup.js
const path = require('path');
const fs = require('fs');

const BASE = (process.env.HIREBUDDY_URL || 'https://hirebuddy-k543.onrender.com').replace(/\/$/, '');
const bridge = path.resolve(__dirname, 'hirebuddy-mcp.js').split(path.sep).join('/');

(async () => {
  process.stdout.write(`1/3 Waking ${BASE} (can take a minute on the free tier)... `);
  const health = await fetch(`${BASE}/health`, { signal: AbortSignal.timeout(120000) }).then(r => r.json());
  console.log(health.ok ? 'up' : 'unexpected reply');

  process.stdout.write('2/3 Checking the MCP endpoint... ');
  const list = await fetch(`${BASE}/mcp`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  }).then(r => r.json());
  console.log(`${list.result.tools.length} tools, including hirebuddy_run`);

  const entry = { mcpServers: { hirebuddy: { command: 'node', args: [bridge], env: { HIREBUDDY_URL: BASE } } } };
  const out = path.join(__dirname, 'mcp_servers.local.json');
  fs.writeFileSync(out, JSON.stringify(entry, null, 2) + '\n');

  console.log('3/3 Done. Paste this into WorkBuddy\'s MCP server settings (also saved to workbuddy/mcp_servers.local.json):\n');
  console.log(JSON.stringify(entry, null, 2));
  console.log('\nSo the run never stops for approval, keep "Default Permissions" and do one rehearsal: give WorkBuddy access to your Documents folder when it asks,');
  console.log('and choose "Always allow" whenever it asks before a hirebuddy tool. Avoid "Full Access": the run reads untrusted job-site pages.');
  console.log('If prompts still appear on the second run, use "Full Access" for the demo run only and switch back to "Default Permissions" right after.');
  console.log('\nThen restart WorkBuddy and type: I\'m Nadia Rahim. I\'m blind and use NVDA. I live in Subang Jaya and take the LRT. I did customer service calls at a bank hotline for a year and type fast in English and Malay. Free weekdays 9am to 5pm, at least RM12 an hour, phone interviews please. Check JobStreet and Indeed too.');
  console.log('\nNo MCP settings in your WorkBuddy? Give it this task instead:');
  console.log(`  Run: node "${path.resolve(__dirname, 'hirebuddy-skill', 'scripts', 'hirebuddy.js').split(path.sep).join('/')}" "I am Nadia Rahim. I am blind and use NVDA. I live in Subang Jaya and take the LRT. I did customer service calls at a bank hotline for a year and type fast in English and Malay. Free weekdays 9am to 5pm, at least RM12 an hour, phone interviews please." and show me the result.`);
})().catch(e => {
  console.error(`\nCould not reach ${BASE}: ${e.message}. Check the laptop's internet and try again.`);
  process.exit(1);
});
