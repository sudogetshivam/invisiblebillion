'use strict';

/**
 * ib file <identity> <filepath>
 */
async function fileCommand(destination, filePath) {
    if (!destination || !filePath) {
        console.error('Usage: ib file <identity> <filepath>');
        console.error('Example: ib file raj@a3f2 ./notes.pdf');
        process.exit(1);
    }

    console.log('\n File transfer is coming in Phase 5.');
    console.log('   Phase 5 will support:');
    console.log('   • Chunked file encryption (AES-256-GCM per chunk)');
    console.log('   • Fully offline transfer over TCP, same epidemic routing');
    console.log('   • Automatic reassembly at the destination\n');
}

module.exports = { fileCommand };
