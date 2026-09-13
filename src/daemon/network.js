'use strict';

const os = require('os');

/**
 * Check if a network interface is a virtual adapter (VMware, WSL, VirtualBox, etc.)
 * These adapters have static host IPs and do not change when physical Wi-Fi changes.
 */
function isVirtualAdapter(name) {
    return /vmware|virtualbox|vbox|vethernet|wsl|hyper-v|loopback|tap|npcap|tailscale|docker/i.test(name);
}

/**
 * Returns all active non-internal IPv4 interfaces.
 * Prioritises physical interfaces (Wi-Fi, Ethernet) over virtual adapters.
 */
function getActiveIPv4Interfaces() {
    const ifaces = os.networkInterfaces();
    const physical = [];
    const virtual = [];

    for (const [name, list] of Object.entries(ifaces)) {
        if (!list) continue;
        const isVirt = isVirtualAdapter(name);
        for (const iface of list) {
            if (iface.family === 'IPv4' && !iface.internal && iface.address) {
                const item = { name, address: iface.address, netmask: iface.netmask };
                if (isVirt) {
                    virtual.push(item);
                } else {
                    physical.push(item);
                }
            }
        }
    }

    return physical.length > 0 ? physical : virtual;
}

/**
 * Returns current machine primary IPv4 address, or null if offline.
 * Favours physical Wi-Fi/Ethernet adapters over virtual host-only networks.
 */
function getCurrentIP() {
    const active = getActiveIPv4Interfaces();
    return active.length > 0 ? active[0].address : null;
}

/**
 * Get a unique fingerprint of all active IPv4 interfaces.
 * Used to detect network changes even if only subnet or secondary adapter changes.
 */
function getNetworkFingerprint() {
    const active = getActiveIPv4Interfaces();
    return active.map(i => `${i.name}:${i.address}`).sort().join(';');
}

/**
 * Start polling for network changes every 4 seconds.
 * Triggers onChangeCallback when physical IP or active adapter changes.
 * Returns a function that stops the watcher when called.
 */
function startNetworkWatcher(onChangeCallback) {
    let currentIP = getCurrentIP();
    let currentFingerprint = getNetworkFingerprint();
    console.log(`[network] Current IP: ${currentIP || 'none'} (fingerprint: ${currentFingerprint || 'offline'})`);

    const interval = setInterval(() => {
        const newFingerprint = getNetworkFingerprint();
        if (newFingerprint !== currentFingerprint) {
            const previousIP = currentIP;
            const newIP = getCurrentIP();
            currentFingerprint = newFingerprint;
            currentIP = newIP;

            console.log(`[network] Network change detected: ${previousIP || 'none'} → ${newIP || 'none'}`);
            try {
                onChangeCallback(newIP, previousIP);
            } catch (err) {
                console.error('[network] onChangeCallback error:', err.message);
            }
        }
    }, 4_000);

    return () => clearInterval(interval);
}

module.exports = { getCurrentIP, getActiveIPv4Interfaces, startNetworkWatcher };
