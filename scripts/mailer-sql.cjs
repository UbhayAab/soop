// Run SQL on the mailer box over SSH. Reads the SQL from stdin.
const { execFileSync } = require('node:child_process');
const sql = require('fs').readFileSync(0, 'utf8').trim();
const escaped = sql.replace(/"/g, '\\"').replace(/\$/g, '\\$$');
const out = execFileSync(
  'ssh',
  ['-i', process.env.USERPROFILE + '\\Desktop\\jarurat-key.pem',
   '-o', 'StrictHostKeyChecking=no', '-o', 'BatchMode=yes',
   'ubuntu@13.207.94.158',
   `sudo -u postgres psql -d jarurat_mailer -v ON_ERROR_STOP=1 -c "${escaped}"`],
  { encoding: 'utf8' },
);
console.log(out);
