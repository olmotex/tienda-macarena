// Configuración pública de Firebase. No es secreta: la seguridad está en las reglas (firestore.rules).
export const firebaseConfig = {
  apiKey: "AIzaSyAzhqYt2wFIM1UCZNIBfuvfgtA7Qh58Ug4",
  authDomain: "tienda-macarena.firebaseapp.com",
  projectId: "tienda-macarena",
  storageBucket: "tienda-macarena.firebasestorage.app",
  messagingSenderId: "117333362361",
  appId: "1:117333362361:web:b053b8abf6227f9191bd68"
};

// Los dos usuarios creados en Firebase > Authentication.
// Si cambias estos correos, cámbialos también en firestore.rules.
export const USERS = {
  kid: { email: "macarena@tienda.app" },
  parent: { email: "papas@tienda.app" }
};
