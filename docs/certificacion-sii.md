# Certificación como emisor electrónico en el SII

Para emitir DTE con validez tributaria usando software propio, la empresa debe certificarse ante el SII. Cuadra opera en ambiente de **certificación** (maullin.sii.cl) hasta completar este proceso.

## Requisitos previos
1. **Certificado digital** de una persona autorizada por la empresa (archivo .pfx/.p12), emitido por un proveedor acreditado.
2. Postulación en sii.cl → Factura electrónica → Sistema de facturación de mercado / propio → **Postulación**. Registre la fecha que entrega el SII: va en *Configuración → Fecha de resolución SII*. En certificación el número de resolución es **0**.
3. Descargar los **CAF de certificación** (sii.cl → Timbraje electrónico, en ambiente de certificación) para cada tipo de documento y cargarlos en *Configuración → Folios autorizados*.

## Etapas
| Etapa | Qué se hace en Cuadra |
|---|---|
| **Set de pruebas** | El SII entrega casos (facturas, notas de crédito/débito, guías). Emita cada caso desde *Emitir documento*. En la referencia de cada documento use tipo `SET` y la glosa `CASO N°`. Consulte el estado en *Documentos emitidos*. |
| **Simulación** | Emita documentos representativos de la operación real. |
| **Intercambio** | Descargue el archivo de prueba del SII, impórtelo en *Documentos recibidos* (genera RespuestaDTE), acepte/reclame y genere el recibo de mercaderías (EnvioRecibos). Suba los XML resultantes en sii.cl. |
| **Muestras impresas** | Abra cada documento → *Imprimir / PDF*. La representación incluye el timbre PDF417. |
| **Declaración de cumplimiento** | Se firma en sii.cl. |

Al obtener la autorización: cambie el ambiente a **producción**, ingrese número y fecha de resolución definitivos y cargue CAF de producción.

## Boletas electrónicas
Las boletas (39/41) usan una API REST distinta y su propio proceso de certificación. Cuadra implementa el envío por esa API, pero su certificación se tramita por separado.

## Endpoints utilizados
| Servicio | Certificación | Producción |
|---|---|---|
| Semilla / token | maullin.sii.cl/DTEWS/CrSeed.jws, GetTokenFromSeed.jws | palena.sii.cl/… |
| Envío DTE | maullin.sii.cl/cgi_dte/UPL/DTEUpload | palena.sii.cl/… |
| Estado envío / DTE | QueryEstUp.jws, QueryEstDte.jws | ídem |
| Aceptación / reclamo | ws2.sii.cl/WSREGISTRORECLAMODTECERT/… | ws1.sii.cl/WSREGISTRORECLAMODTE/… |
| Boletas | apicert.sii.cl, pangal.sii.cl | api.sii.cl, rahue.sii.cl |

Están centralizados en `supabase/functions/_shared/sii/cliente.ts` por si el SII los cambia.
