'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { IB_DIR } = require('../identity/index');

const KEYS_DIR = path.join(IB_DIR, 'keys');
const PUBLIC_KEY_FILE = path.join(KEYS_DIR, 'public.pem');
const PRIVATE_KEY_FILE = path.join(KEYS_DIR, 'private.pem');

//using RSA algorithm to generate keypair
function generateKeypair() {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('rsa', {
        modulusLength: 2048,
        //use spki format for public key and pkcs8 format for private key
        //pem is a text format for keys
        publicKeyEncoding: { type: 'spki', format: 'pem' },
        /**
         * something like this
         * -----BEGIN PUBLIC KEY-----
         * MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEA...
         * -----END PUBLIC KEY-----
         */
        privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    return { publicKey, privateKey };
}

/**
 * Load existing keypair from disk, or generate and save a new one.
 * Returns { publicKey, privateKey } as PEM strings.
 */
function loadOrCreateKeypair() {
    if (!fs.existsSync(KEYS_DIR)) {
        fs.mkdirSync(KEYS_DIR, { recursive: true });
    }

    //if key already exists, then load it
    if (fs.existsSync(PUBLIC_KEY_FILE) && fs.existsSync(PRIVATE_KEY_FILE)) {
        const publicKey = fs.readFileSync(PUBLIC_KEY_FILE, 'utf8');
        const privateKey = fs.readFileSync(PRIVATE_KEY_FILE, 'utf8');
        return { publicKey, privateKey };
    }

    //if not, generate and save it
    const { publicKey, privateKey } = generateKeypair();
    fs.writeFileSync(PUBLIC_KEY_FILE, publicKey, 'utf8');
    // Private key: restrict permissions on unix-like systems
    /*
    The number is in octal format.

    0o600

    Break it down:

    Digit	Meaning
    6	owner permissions
    0	group permissions
    0	others permissions
    */
    fs.writeFileSync(PRIVATE_KEY_FILE, privateKey, { encoding: 'utf8', mode: 0o600 });

    console.log('🔑 RSA keypair generated and stored in ~/.ib/keys/');
    return { publicKey, privateKey };
}

/**
 * Load public key PEM for the local user.
 * Throws if not found (daemon should call loadOrCreateKeypair first).
 */
function loadPublicKey() {
    if (!fs.existsSync(PUBLIC_KEY_FILE)) {
        throw new Error('No public key found. Run: ib start');
    }
    return fs.readFileSync(PUBLIC_KEY_FILE, 'utf8');
}

/**
 * Load private key PEM for the local user, also used by daemon to sign messages
 */
function loadPrivateKey() {
    if (!fs.existsSync(PRIVATE_KEY_FILE)) {
        throw new Error('No private key found. Run: ib start');
    }
    return fs.readFileSync(PRIVATE_KEY_FILE, 'utf8');
}

module.exports = {
    loadOrCreateKeypair,
    loadPublicKey,
    loadPrivateKey,
    PUBLIC_KEY_FILE,
    PRIVATE_KEY_FILE,
};
