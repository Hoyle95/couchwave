// ---------- Couchwave ----------
const VERSION = '0.5.0-beta';
require('./lib/common').VERSION = VERSION;

// ---------- Commands for whoever runs it, or the server ----------
const COMMANDS = ['--version', '--update', '--logout-everyone', '--delete-account', '--set-password', '--stop', '--status', '--remove-song', '--clear'];
const command = COMMANDS.find(c => process.argv.includes(c));
if (command) require('./lib/commands')(command, process.argv.slice(process.argv.indexOf(command) + 1));
else require('./lib/start');
