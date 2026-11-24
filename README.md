# Cuadra Contable — versión simple

Contabilidad web para empresas chilenas: plan de cuentas, asientos, compras y ventas con IVA, libros, balances, estado de resultados, propuesta de F29, varias empresas por cuenta y usuarios con roles.

- **Backend:** Supabase (proyecto `cuadra-contable`, ya migrado). Toda la lógica contable y de permisos vive en la base de datos.
- **Frontend:** React 18 + Vite (`web/`), pensado para publicarse en Cloudflare Pages.
- **SII:** no hay conexión directa en esta versión. Los documentos se ingresan a mano. El código de DTE de la versión anterior (`supabase/functions/`, `tests/sii.test.ts`, `docs/certificacion-sii.md`) y sus tablas se conservan sin uso, para retomarlo más adelante.

## Cómo levantarlo

```bash
cd web
cp .env.example .env.local     # URL y clave publicable del proyecto (son públicas)
npm install
npm run dev                    # http://localhost:5173
```

**Primer ingreso:** creas tu cuenta, confirmas el correo y activas la verificación en dos pasos (app autenticadora). Después creas una empresa, y esta trae un plan de cuentas chileno base.

## Publicar en Cloudflare Pages

1. En Cloudflare Pages conecta el repositorio. Usa el directorio `web`, el comando de build `npm run build` y la salida `dist`.
2. Define las variables `VITE_SUPABASE_URL` y `VITE_SUPABASE_KEY`.
3. `public/_headers` ya trae CSP estricta, HSTS, bloqueo de iframes y otras cabeceras. `public/_redirects` hace que funcionen las rutas de la SPA.
4. En Supabase, en Auth → URL Configuration, agrega el dominio de Pages como *Site URL* y en *Redirect URLs*.

## Módulos

| Pantalla | Qué hace |
|---|---|
| Panel | KPIs (ventas, margen, caja, liquidez, días de cobro y pago, endeudamiento, IVA del mes) y gráficos mensuales |
| Compras y ventas | Registra facturas, boletas y notas de crédito o débito. Calcula el IVA al 19 %, crea el asiento automáticamente, permite anular (anula o reversa el asiento) y exportar el libro en CSV |
| Asientos | Asientos manuales con validación de que cuadren, borradores, contabilización con folio correlativo, anulación y reverso |
| Libros y estados | Libro diario, libro mayor, balance de 8 columnas, balance general y estado de resultados, todos exportables a CSV |
| Propuesta F29 | Códigos 538, 537, 504, 89, 77, 563, 115, 62 y 91, con el remanente arrastrado del mes anterior |
| Plan de cuentas | Árbol de cuentas, alta de cuentas y elección de las cuentas automáticas (clientes, proveedores, IVA, etc.) |
| Ver la app como (solo admin) | Selector en el menú lateral para actuar como contador, operador, auditor o lector. La base de datos aplica de verdad los permisos de ese rol; "Volver a Administrador" siempre funciona y cada cambio queda auditado |
| Empresa y usuarios | Datos de la empresa, roles (admin, contador, operador, auditor, lector), cierre y reapertura de períodos, y auditoría con verificación de integridad |

## Seguridad

- **RLS en todas las tablas.** Cada usuario ve solo las empresas de las que es miembro.
- **Dos pasos obligatorio (TOTP).** La base de datos rechaza cualquier escritura que no venga de una sesión `aal2`; no basta con la validación del frontend.
- **Escritura solo por funciones.** Los documentos no se pueden insertar directo: `registrar_documento` valida el rol, el RUT (módulo 11), los montos, el IVA y el período abierto.
- **Asientos inmutables.** Un asiento contabilizado no se edita: solo se anula o se reversa. Los períodos cerrados no aceptan movimientos.
- **Auditoría encadenada con SHA-256.** Cada cambio guarda quién lo hizo, la IP y el antes y después, y la cadena se puede verificar desde la app.
- **Sesión en `sessionStorage`.** Se cierra al cerrar la pestaña y también tras 20 minutos sin actividad. La contraseña debe tener al menos 12 caracteres.
- **Cabeceras HTTP.** CSP sin scripts externos, HSTS, `X-Frame-Options: DENY`, nosniff y Permissions-Policy.
- **Exportación CSV protegida.** Neutraliza la inyección de fórmulas al abrir el archivo en Excel.

**Pendiente en el panel de Supabase (no se puede hacer por SQL):**
- Activar *Leaked password protection* en Auth → Providers → Email → Password security.
- Mantener activa la confirmación de correo.
- Configurar un SMTP propio para producción.

## Pruebas

```bash
npm ci && npx vitest run      # firma/DTE (versión anterior)
./tests/sql/run.sh            # reglas contables y seguridad, incluye compras/ventas y F29
```

## Migraciones de esta versión

`supabase/migrations/`:
- `documentos_manual`: tabla `documentos` y las funciones `registrar_documento`, `anular_documento`, `propuesta_f29`, `guardar_f29` y `metricas_documentos`.
- `asientos_origen_documentos`: permite los orígenes `documento_venta` y `documento_compra`.
- `miembros_perfiles_fk`: relación entre miembros y perfiles para mostrar nombres.
- `probar_rol`: columna `miembros.rol_prueba`, función `probar_rol()` y `app.tiene_rol` usando el rol efectivo.

La propuesta de F29 es **referencial**: no incluye el reajuste UTM del remanente, retenciones de honorarios ni otros impuestos. Revísala en sii.cl antes de declarar.
