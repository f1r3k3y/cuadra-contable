// Punto de entrada único de las Edge Functions de Cuadra.
// Rutas: /functions/v1/cuadra/<ruta>
import credenciales from './rutas/credenciales.ts';
import dteEmitir from './rutas/dte-emitir.ts';
import dteEstado from './rutas/dte-estado.ts';
import dteRecibir from './rutas/dte-recibir.ts';
import rcvSync from './rutas/rcv-sync.ts';
import { cors } from '../_shared/http.ts';

const rutas: Record<string, (req: Request) => Promise<Response>> = {
  credenciales,
  'dte-emitir': dteEmitir,
  'dte-estado': dteEstado,
  'dte-recibir': dteRecibir,
  'rcv-sync': rcvSync,
};

Deno.serve((req) => {
  const ruta = new URL(req.url).pathname.split('/').filter(Boolean).pop() ?? '';
  const h = rutas[ruta];
  if (!h) {
    return new Response(JSON.stringify({ error: 'Ruta no encontrada' }), {
      status: 404,
      headers: { ...cors(req), 'Content-Type': 'application/json' },
    });
  }
  return h(req);
});
