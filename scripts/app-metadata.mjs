import { readFileSync } from "node:fs";

export const root = new URL("../", import.meta.url);
export const read = (path) => readFileSync(new URL(path, root), "utf8");
export const readConfig = () => JSON.parse(read("src-tauri/tauri.conf.json"));
