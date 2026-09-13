'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const crypto = require('crypto');

const IB_DIR = path.join(os.homedir(), '.ib'); //if any user has installed this library, its directory will get stored with this path
const IDENTITY_FILE = path.join(IB_DIR, 'identity.json');

function generateShortId() {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = '';
  // Generate extra bytes to account for rejection sampling (uniform distribution)
  const bytes = crypto.randomBytes(16); //generate 16 random numbers from 0 -> 255
  let byteIndex = 0;
  while (id.length < 4) {
    const byte = bytes[byteIndex++];
    // Only accept bytes that fall within chars length
    if (byte < 256 - (256 % chars.length)) {
      id += chars[byte % chars.length];
    }
  }
  return id;
}


function promptUsername() {
  return new Promise((resolve) => {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    rl.question('\n🌍 Welcome to The Invisible Billion!\nEnter your username (e.g. shivam): ', (answer) => {
      rl.close();
      const name = answer.trim().toLowerCase().replace(/[^a-z0-9_-]/g, '');
      if (!name) {
        console.error('Username cannot be empty. Using "user" as default.');
        resolve('user');
      } else {
        resolve(name);
      }
    });
  });
}

/**
 * Load existing identity from disk, or create a new one interactively.
 * Returns: { username, shortId, identity }
 *   where identity = "username@shortId"
 */
async function loadOrCreate() {
  // Ensure ~/.ib directory exists
  if (!fs.existsSync(IB_DIR)) {
    fs.mkdirSync(IB_DIR, { recursive: true });
  }

  if (fs.existsSync(IDENTITY_FILE)) {
    const raw = fs.readFileSync(IDENTITY_FILE, 'utf8');
    const data = JSON.parse(raw);
    return data;
  }

  // First time prompt and create your username
  const username = await promptUsername();
  const shortId = generateShortId();
  const identity = `${username}@${shortId}`;

  const data = { username, shortId, identity };
  fs.writeFileSync(IDENTITY_FILE, JSON.stringify(data, null, 2), 'utf8');

  console.log(`\n✅ Identity created: ${identity}`);
  console.log(`   Your IB ID is: ${identity}`);
  console.log(`   Share this with contacts so they can message you.\n`);

  return data;
}

/**
 * Load identity without prompting — throws error if not found.
 * Used by the daemon (which should never prompt).
 */
function loadIdentity() {
  if (!fs.existsSync(IDENTITY_FILE)) {
    throw new Error('No identity found. Run: ib start');
  }
  const raw = fs.readFileSync(IDENTITY_FILE, 'utf8');
  return JSON.parse(raw);
}

module.exports = { loadOrCreate, loadIdentity, IB_DIR };
