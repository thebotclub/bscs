const fs = require('fs');
const path = require('path');
const file = path.join(__dirname, '..', 'dist', 'bin', 'bscs.js');
let content = fs.readFileSync(file, 'utf8');
content = content.replace('#!/usr/bin/env tsx', '#!/usr/bin/env node');
fs.writeFileSync(file, content);
fs.chmodSync(file, 0o755);
console.log('postbuild: fixed shebang and permissions');
