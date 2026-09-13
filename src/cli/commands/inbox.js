'use strict';

const { runCommand } = require('../ipc');

async function inboxCommand() {
    await runCommand({ type: 'inbox' }, (res) => {
        if (!res.ok) {
            console.error('❌', res.error);
            return;
        }

        const content = res.content || '';
        if (!content.trim()) {
            console.log('\n📭 Inbox is empty. No messages received yet.\n');
            return;
        }

        console.log('\n📬 Received Messages:\n');
        console.log('──────────────────────────────────────────────────');
        console.log(content.trim());
        console.log('──────────────────────────────────────────────────\n');
    });
}

module.exports = { inboxCommand };
