const { spawn } = require('child_process');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: 'inherit',
      shell: process.platform === 'win32',
    });

    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) {
        resolve();
      } else {
        reject(new Error(`${command} ${args.join(' ')} failed with exit code ${code}`));
      }
    });
  });
}

async function main() {
  await run('npx', ['prisma', 'migrate', 'deploy']);
  await run('node', ['scripts/create-backup.js', 'PRE_DEPLOY']);
  await run('node', ['index.js']);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
