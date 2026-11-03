# La tienda de Macarena

App para las ventas de la tienda de Macarena. Funciona como app en el celular (se agrega a la pantalla de inicio) y no necesita Claude.

- **Celular de Macarena:** entra con `macarena@tienda.app`. Solo ve la tienda: vende y puede deshacer su última venta.
- **Celular de los papás:** entra con `papas@tienda.app`. Ve ventas de hoy, cierre de caja, dulces y precios, historial y ajustes.

Los datos se guardan en Firebase (proyecto `tienda-macarena`) y se ven en los dos celulares al instante. Si se cae el internet, la app sigue funcionando y sube las ventas cuando vuelve.

## Archivos

- `index.html`, `styles.css`, `app.js`: la app.
- `firebase-config.js`: conexión a Firebase y correos de los dos usuarios.
- `firestore.rules`: reglas de seguridad. Hay que pegarlas en Firebase > Firestore Database > Reglas cada vez que cambien.
- `vendor/firebase.js`: librería de Firebase 10.14.1 empaquetada.
- `sw.js`, `manifest.webmanifest`, `icons/`: para que se instale como app. Al cambiar la app, sube la versión en `sw.js` (`tienda-v1` → `tienda-v2`).

## Inicio, cambiar de usuario y Face ID

- El botón 🏠 lleva a la pantalla de inicio, donde se elige "Soy Macarena" o "Somos los papás".
- Cada usuario escribe su contraseña una sola vez por celular y la sesión queda guardada.
- Después de la contraseña, la app ofrece activar Face ID, huella o la clave del celular. Si está activado, se entra desde el inicio con eso. Si los papás no lo activan, al ir al inicio se cierra su sesión y la próxima vez se pide la contraseña, para que Macarena no pueda entrar a su modo.
- Si la app queda en segundo plano más de 2 minutos, vuelve a pedir Face ID.
- En el inicio, "Cerrar sesiones guardadas" borra las sesiones de ese celular.
