// apps/mini-app/src/firebase.ts
import { initializeApp } from "firebase/app";
import { getFirestore } from "firebase/firestore";

// For Firebase JS SDK v7.20.0 and later, measurementId is optional
const firebaseConfig = {
  apiKey: "AIzaSyC0ppG6bLbNQaHb-3o-d_q24JMYrng8Y6g",
  authDomain: "spendly-d29b7.firebaseapp.com",
  projectId: "spendly-d29b7",
  storageBucket: "spendly-d29b7.firebasestorage.app",
  messagingSenderId: "806604181014",
  appId: "1:806604181014:web:9ad032f19d4771c4562f37",
  measurementId: "G-G9CK6DKS9N"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);