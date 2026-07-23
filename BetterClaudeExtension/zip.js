const AdmZip = require("adm-zip");
const path = require("path");

const zip = new AdmZip();
const root = __dirname;
["manifest.json", "background", "content", "popup", "dist", "icons"].forEach((entry) => {
  const full = path.join(root, entry);
  if (entry.endsWith(".json")) zip.addLocalFile(full);
  else zip.addLocalFolder(full, entry);
});
const outPath = path.join(root, "betterclaude-extension.zip");
zip.writeZip(outPath);
console.log("Wrote", outPath);
