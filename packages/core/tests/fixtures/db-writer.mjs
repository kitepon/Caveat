import { DatabaseSync } from 'node:sqlite';
const db = new DatabaseSync(process.argv[2]);
db.exec('BEGIN IMMEDIATE');
process.send('locked');
process.once('message', ({ releaseAfterMs }) => {
  setTimeout(() => {
    db.exec('COMMIT');
    db.close();
    process.disconnect();
  }, releaseAfterMs);
});
