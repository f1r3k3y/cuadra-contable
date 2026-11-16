# Seguridad

## Controles implementados

### Identidad y acceso
- **MFA obligatorio (TOTP)**: el frontend no deja operar sin `aal2`; la base de datos (`app.mfa_ok()`) y la Edge Function rechazan escrituras sin MFA, aunque alguien llame la API directamente.
- **Claves robustas**: mínimo 12 caracteres con mayúsculas, minúsculas, números y símbolos; confirmación de correo; rotación de refresh tokens.
- **Roles por empresa**: `admin`, `contador`, `operador`, `auditor`, `lector`. Cada tabla tiene políticas RLS por empresa y rol. La empresa siempre conserva al menos un administrador.
- **Aislamiento multiempresa**: un usuario solo ve las empresas de las que es miembro (RLS en las 19 tablas; verificado en pruebas).
- **Rol anónimo sin acceso**: se revocan tablas y funciones al rol `anon`.

### Integridad contable
- Los comprobantes se crean en borrador; solo `contabilizar_asiento()` los contabiliza, tras verificar cuadratura, cuentas imputables, auxiliares y período abierto.
- Un comprobante contabilizado **no se edita ni se borra**: se anula (período abierto, con motivo) o se reversa con un comprobante inverso.
- Los períodos cerrados bloquean cualquier movimiento; solo un administrador los reabre.
- La numeración es correlativa por año y se asigna con bloqueo para evitar duplicados.

### Bitácora de auditoría
- Cada cambio en tablas sensibles queda con usuario, IP, fecha, estado anterior y nuevo.
- Es **append-only** (trigger que impide UPDATE/DELETE) y está **encadenada con SHA-256**: cada registro incluye el hash del anterior. `verificar_auditoria()` detecta cualquier alteración.

### Secretos (certificado digital y CAF)
- Se cifran con **AES-256-GCM** en la Edge Function; la clave maestra (`CUADRA_MASTER_KEY`) vive solo en los secrets de Supabase, nunca en la base ni en el navegador.
- El id de la empresa va como dato asociado (AAD): un secreto copiado a otra empresa no se descifra.
- La tabla `secretos` no tiene políticas RLS ni privilegios para usuarios: solo el rol de servicio la lee.
- Los folios se reservan con una función que solo puede ejecutar el rol de servicio.

### Aplicación web
- Encabezados: CSP estricta, HSTS, `X-Frame-Options: DENY`, `nosniff`, `Referrer-Policy`, `Permissions-Policy`.
- Fuentes servidas localmente (sin terceros); sin `eval` ni scripts externos.
- Exportaciones CSV protegidas contra inyección de fórmulas.
- Límite de solicitudes por usuario en la Edge Function; validación de tamaño y formato de archivos.

### Base de datos
- Todas las funciones con `search_path` fijo; funciones `SECURITY DEFINER` revisadas y con verificación explícita de rol + MFA.
- Revisado con el analizador de seguridad de Supabase.

## Responsabilidades del operador
- Guardar `CUADRA_MASTER_KEY` en un gestor de claves y respaldarla.
- Activar copias de seguridad (PITR) del proyecto Supabase.
- Revisar periódicamente usuarios y roles, y verificar la integridad de la bitácora.
- Tratamiento de datos personales conforme a la Ley 19.628 y la Ley 21.719 de protección de datos personales.

## Reporte de vulnerabilidades
Escriba al administrador del proyecto. No abra issues públicos con detalles explotables.
