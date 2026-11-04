const fs = require('node:fs/promises');
const path = require('node:path');
async function build() {
 const root = path.resolve(__dirname, '../..');
 const packages = {skill:['skill-creator','skill-installer'],mcp:['mcp-manager'],plugin:['plugin-manager']};
 for (const [kind,names] of Object.entries(packages)) {
  const relative = `${kind}/capability`;
  const destination = path.join(root, 'dist/main', relative);
  await fs.rm(destination, { recursive: true, force: true });
  await fs.mkdir(destination, { recursive: true });
  for (const name of names) {
   const source = path.join(root, 'src/main', relative, name);
   await fs.access(path.join(source, 'SKILL.md'));
   await fs.cp(source, path.join(destination, name), { recursive: true });
  }
 }
 const destination = path.join(root, 'dist/main/platform');
 await fs.mkdir(destination, { recursive: true });
 for (const name of ['description-zh.md', 'component-descriptions.zh.json']) {
  await fs.copyFile(path.join(root, 'src/main/platform', name), path.join(destination, name));
 }
}
module.exports = { build };
if (require.main === module) build().catch(error => { console.error(error); process.exitCode = 1; });
