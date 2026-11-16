# Cuadra Contable

Software contable y de facturación electrónica para empresas en Chile: multiempresa, contabilidad por partida doble, conexión directa con el Servicio de Impuestos Internos (SII), seguridad por diseño y panel de métricas.

> "Cuadra" es una marca ficticia del proyecto.

## Qué incluye

| Módulo | Funcionalidad |
|---|---|
| **Contabilidad** | Plan de cuentas jerárquico (base PYME chilena), comprobantes de ingreso, egreso y traspaso, numeración correlativa por año, anulación y reverso, cierre y reapertura de períodos, centros de costo, auxiliares de clientes y proveedores |
| **Libros** | Libro diario, libro mayor con saldo acumulado, balance tributario de 8 columnas, libros de compras y ventas |
| **Estados financieros** | Estado de resultados y balance general |
| **Facturación electrónica (DTE)** | Emisión de factura (33), factura exenta (34), boleta (39/41), guía de despacho (52), notas de débito (56) y de crédito (61): timbre (TED) con CAF, firma XMLDSig, envío al SII, consulta de estado, representación impresa con PDF417 |
| **Recepción** | Importación del XML de proveedores, acuse de recepción (RespuestaDTE), aceptación o reclamo en el SII (Ley 19.983) y recibo de mercaderías (EnvioRecibos) |
| **RCV** | Sincronización del Registro de Compras y Ventas (producción) o importación del CSV de sii.cl, con cuadratura contra la contabilidad |
| **F29** | Propuesta de IVA y PPM calculada desde los libros (códigos 502, 503, 509, 510, 520, 537, 538, 89, 77, 62, 91…) |
| **Métricas** | Ventas, resultado, márgenes, liquidez, prueba ácida, endeudamiento, capital de trabajo, días de cobro y pago, flujo de caja, principales clientes, proveedores y gastos, alertas de plazos SII |
| **Contabilización automática** | Cada DTE aceptado genera su asiento con las cuentas configuradas |

## Arquitectura

```
web/                       React + Vite (Cloudflare Pages)
supabase/migrations/       Postgres: esquema, RLS, reglas contables, reportes
supabase/functions/
  cuadra/                  Edge Function única con rutas: credenciales, dte-emitir,
                           dte-estado, dte-recibir, rcv-sync
  _shared/sii/             Núcleo SII sin dependencias de runtime (Node y Deno)
tests/                     Pruebas del núcleo SII (Vitest) y de la base de datos (SQL)
```

- **Base de datos**: Supabase Postgres. Las reglas contables (cuadratura, inmutabilidad, períodos, numeración) viven en la base, no en el navegador, así no se pueden saltar.
- **SII**: el núcleo construye el XML ya en forma canónica (C14N), firma con RSA-SHA1 como exige el SII, y habla con los servicios SOAP/REST de certificación (`maullin`) o producción (`palena`).

## Puesta en marcha

### 1. Base de datos
Las migraciones de `supabase/migrations` ya están aplicadas en el proyecto `cuadra-contable`. Para otro proyecto: `supabase db push`.

### 2. Secretos de la Edge Function
En el dashboard de Supabase → **Edge Functions → Secrets**:

| Secreto | Valor |
|---|---|
| `CUADRA_MASTER_KEY` | 32 bytes aleatorios en base64: `openssl rand -base64 32`. **Guárdelo en un gestor de claves**: sin él no se pueden descifrar los certificados ni los CAF cargados. |
| `CUADRA_ORIGENES` | URL(s) del frontend separadas por coma, ej. `https://cuadra.pages.dev,http://localhost:5173` |

`SUPABASE_URL`, `SUPABASE_ANON_KEY` y `SUPABASE_SERVICE_ROLE_KEY` los inyecta Supabase.

### 3. Autenticación
En **Authentication → Providers**: habilite correo con confirmación. En **Authentication → Multi-Factor**: habilite TOTP. El sistema exige MFA para operar.

### 4. Frontend
```bash
cd web
cp .env.example .env    # URL y publishable key del proyecto
npm install
npm run dev             # http://localhost:5173
npm run build           # dist/ para Cloudflare Pages
```
En Cloudflare Pages: directorio raíz `web`, comando `npm run build`, salida `dist`, y las variables `VITE_SUPABASE_URL` y `VITE_SUPABASE_ANON_KEY`. Los encabezados de seguridad están en `web/public/_headers`.

### 5. Primer uso
1. Crear cuenta, activar la verificación en dos pasos y registrar la empresa (se crea el plan de cuentas).
2. **Configuración**: fecha de resolución SII, certificado digital (.pfx) y CAF de cada tipo de documento.
3. Emitir documentos en ambiente de **certificación** y completar el proceso del SII (ver `docs/certificacion-sii.md`).
4. Al recibir la resolución, cambiar el ambiente a **producción**.

## Pruebas

```bash
npm install
npx vitest run           # núcleo SII: RUT, totales, TED, firma XMLDSig, sobres, intercambio, F29, RCV
./tests/sql/run.sh       # 44 verificaciones de reglas contables y seguridad sobre Postgres local
cd supabase/functions && deno check --config deno.json cuadra/index.ts
```

Las firmas se validan con un verificador XMLDSig independiente (`xml-crypto`), incluida la firma del sobre en su contexto de namespaces.

## Límites conocidos

- **Certificación SII**: el código implementa los formatos y servicios, pero la habilitación como emisor la otorga el SII tras el set de pruebas, simulación e intercambio con la empresa real y su certificado. Algunos detalles (glosas, endpoints de reclamo y boleta) se confirman en esa etapa.
- **F29**: es una propuesta para contrastar con la del SII; no se presenta automáticamente (el SII no ofrece API pública para declarar).
- **RCV en línea**: usa el servicio de la consulta web del SII, que no es una API documentada; si cambia, queda la importación del CSV.
- **Fuera del alcance de esta versión**: remuneraciones, inventario, conciliación bancaria, activo fijo y depreciación automática, envío de DTE por correo al receptor.
