import { copyFileSync, writeFileSync } from "node:fs";
import { read, readConfig, root } from "./app-metadata.mjs";

const { productName, identifier, bundle: { publisher, shortDescription } } = readConfig();
const main = new URL("src-tauri/gen/android/app/src/main/", root);
const kotlin = new URL(`java/${identifier.replaceAll(".", "/")}/`, main);
for (const source of ["MainActivity.kt", "LanPlugin.kt"]) {
  copyFileSync(new URL(`src-tauri/android/${source}`, root), new URL(source, kotlin));
}

function androidString(value) {
  return '"' + value.replace(/[\\"]/g, "\\$&")
    .replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;") + '"';
}

writeFileSync(new URL("res/values/strings.xml", main), `<resources>
    <string name="app_name">${androidString(productName)}</string>
    <string name="main_activity_title">${androidString(productName)}</string>
    <string name="app_description">${androidString(shortDescription)}</string>
    <string name="app_author">${androidString(publisher)}</string>
</resources>
`);

const manifestPath = "src-tauri/gen/android/app/src/main/AndroidManifest.xml";
let manifest = read(manifestPath);
// The in-app client joins LAN hosts over ws://, including in release builds.
manifest = manifest.replace(/android:usesCleartextTraffic="[^"]*"/, 'android:usesCleartextTraffic="true"');
for (const permission of ["ACCESS_NETWORK_STATE", "ACCESS_LOCAL_NETWORK"]) {
  const name = `android.permission.${permission}`;
  if (!manifest.includes(name)) {
    manifest = manifest.replace(/(\s*<uses-permission android:name="android.permission.INTERNET"\s*\/>)/,
      `$1\n    <uses-permission android:name="${name}" />`);
  }
}
if (!manifest.includes('android:description="@string/app_description"')) {
  manifest = manifest.replace(/<application\b/, '<application\n        android:description="@string/app_description"');
}
if (!manifest.includes('android:name="fr.bastides.app.AUTHOR"')) {
  manifest = manifest.replace(/(<application\b[^>]*>)/,
    '$1\n        <meta-data android:name="fr.bastides.app.AUTHOR" android:resource="@string/app_author" />');
}
writeFileSync(new URL(manifestPath, root), manifest);
