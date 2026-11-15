import { writeFileSync } from "node:fs";
import { read, readConfig, root } from "./app-metadata.mjs";

const args = process.argv.slice(2);
const config = readConfig();
const version = args.length === 0 ? config.version : args[0];
const match = /^(0|[1-9]\d{0,3})\.(0|[1-9]\d{0,2})\.(0|[1-9]\d{0,2})$/.exec(version);
if (args.length > 1 || !match || version === "0.0.0" ||
    Number(match[1]) * 1_000_000 + Number(match[2]) * 1_000 + Number(match[3]) > 2_100_000_000) {
  console.error("Utilisation : set-version.bat MAJEUR.MINEUR.CORRECTIF (ex. 0.1.1)");
  process.exit(1);
}

const { productName, bundle: { publisher, shortDescription } } = config;
const packageJson = JSON.parse(read("package.json"));
const lock = JSON.parse(read("package-lock.json"));
const cargo = read("src-tauri/Cargo.toml")
  .replace(/^(version = ).*$/m, `$1"${version}"`)
  .replace(/^(description = ).*$/m, `$1${JSON.stringify(shortDescription)}`)
  .replace(/^(authors = .*\r?\n)?(?=edition = )/m, `authors = [${JSON.stringify(publisher)}]\n`);
const cargoLock = read("src-tauri/Cargo.lock")
  .replace(/(\[\[package\]\]\r?\nname = "bastides"\r?\nversion = )"[^"]+"/, `$1"${version}"`);

const files = {
  "src-tauri/tauri.conf.json": read("src-tauri/tauri.conf.json")
    .replace(/("version": )"[^"]+"/, `$1"${version}"`)
    .replace(/("label": "main", "title": )"(?:\\.|[^"\\])*"/, (_, prefix) =>
      prefix + JSON.stringify(productName)),
  "package.json": JSON.stringify({
    ...packageJson, version, description: shortDescription, author: publisher,
  }, null, 2) + "\n",
  "package-lock.json": JSON.stringify({
    ...lock, version, packages: {
      ...lock.packages,
      "": { ...lock.packages[""], version },
    },
  }, null, 2) + "\n",
  "src-tauri/Cargo.toml": cargo,
  "src-tauri/Cargo.lock": cargoLock,
};
for (const [path, contents] of Object.entries(files)) {
  if (read(path) !== contents) writeFileSync(new URL(path, root), contents);
}
console.log(`${productName} ${version}`);
