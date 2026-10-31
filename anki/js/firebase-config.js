// Configuração do Firebase do projeto "questoessimplepresent".
// Estes valores identificam o projeto e são públicos por natureza (não são senha).
// Analytics não é usado neste sistema, então não é carregado.
export const firebaseConfig = {
  apiKey: "AIzaSyAOIIomhwqbUcBHRebsXiIgPc9IqTJmNuU",
  authDomain: "questoessimplepresent.firebaseapp.com",
  projectId: "questoessimplepresent",
  storageBucket: "questoessimplepresent.firebasestorage.app",
  messagingSenderId: "479903295803",
  appId: "1:479903295803:web:98a2f6354b85da554e2f1e",
  measurementId: "G-195GRKGNDY",
};

export function isFirebaseConfigured(cfg = firebaseConfig) {
  const required = ["apiKey", "authDomain", "projectId", "appId"];
  return required.every((k) => typeof cfg[k] === "string" && cfg[k] && !cfg[k].startsWith("PREENCHA"));
}
