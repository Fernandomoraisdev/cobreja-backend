require('dotenv').config();

const prisma = require('../prisma');
const { createBackupSnapshot } = require('../services/backup.service');

async function main() {
  const kind = process.argv[2] || 'PRE_DEPLOY';
  const snapshot = await createBackupSnapshot({ kind });
  console.log(JSON.stringify({
    ok: true,
    id: snapshot.id,
    kind: snapshot.kind,
    fileName: snapshot.fileName,
    counts: snapshot.counts,
    createdAt: snapshot.createdAt,
  }, null, 2));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
