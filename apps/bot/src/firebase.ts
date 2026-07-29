import { initializeApp, cert } from "firebase-admin";
import { getFirestore } from "firebase-admin/firestore";
import { readFileSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));

const serviceAccountPath = resolve(__dirname, "firebase-admin.json");
const serviceAccount = JSON.parse(readFileSync(serviceAccountPath, "utf-8"));

initializeApp({
  credential: cert(serviceAccount),
});

export const firestore = getFirestore();