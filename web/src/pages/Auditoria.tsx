import { useState } from 'react';
import { supabase, rpc } from '../lib/supabase';
import { useEmpresa, useSesion } from '../lib/sesion';
import { fechaHora, csv } from '../lib/fmt';
import { Pagina, Tarjeta, Boton, Campo, Selector, Aviso, Vacio, Cargando, Modal, useCarga } from '../components/ui';

export function Auditoria() {
  const empresa = useEmpresa();
  const { puede } = useSesion();
  const [tabla, setTabla] = useState('');
  const [ver, setVer] = useState<any | null>(null);
  const [integridad, setIntegridad] = useState<{ tipo: 'ok' | 'error'; txt: string } | null>(null);

  const { datos, cargando, error } = useCarga(async () => {
    if (!puede('admin', 'auditor')) return [];
    let q = supabase.from('auditoria').select('*').eq('empresa_id', empresa.id).order('id', { ascending: false }).limit(300);
    if (tabla) q = q.eq('tabla', tabla);
    const { data, error } = await q;
    if (error) throw new Error(error.message);
    return data;
  }, [empresa.id, tabla]);

  async function verificar() {
    try {
      const roto = await rpc<number | null>('verificar_auditoria', { p_empresa: empresa.id });
      setIntegridad(roto === null ? { tipo: 'ok', txt: '✓ La cadena de hashes está íntegra: ningún registro fue alterado ni eliminado.' } : { tipo: 'error', txt: `✕ La cadena se rompe en el registro ${roto}.` });
    } catch (e) {
      setIntegridad({ tipo: 'error', txt: (e as Error).message });
    }
  }

  if (!puede('admin', 'auditor')) return <Pagina titulo="Auditoría"><Aviso tipo="alerta">Solo administradores y auditores pueden ver la bitácora.</Aviso></Pagina>;

  return (
    <Pagina titulo="Bitácora de auditoría" sub="Cada cambio queda registrado con usuario, IP y fecha, encadenado con SHA-256. La bitácora no se puede editar ni borrar."
      acciones={<>
        <Boton variante="secundario" onClick={() => csv('auditoria.csv', (datos ?? []).map(({ antes, despues, ...r }: any) => ({ ...r, antes: JSON.stringify(antes), despues: JSON.stringify(despues) })))}>Exportar CSV</Boton>
        <Boton onClick={verificar}>Verificar integridad</Boton>
      </>}>
      {integridad && <Aviso tipo={integridad.tipo}>{integridad.txt}</Aviso>}
      <div className="filtros">
        <Campo etiqueta="Tabla">
          <Selector value={tabla} onChange={(e) => setTabla(e.target.value)}>
            <option value="">Todas</option>
            {['asientos', 'asiento_lineas', 'dte_emitidos', 'dte_recibidos', 'cuentas', 'miembros', 'empresas', 'certificados', 'cafs', 'periodos', 'f29_declaraciones', 'auxiliares'].map((t) => <option key={t}>{t}</option>)}
          </Selector>
        </Campo>
      </div>
      <Aviso tipo="error">{error}</Aviso>
      <Tarjeta>
        {cargando ? <Cargando /> : !datos?.length ? <Vacio>Sin registros.</Vacio> : (
          <table className="tabla compacta">
            <thead><tr><th>#</th><th>Fecha</th><th>Tabla</th><th>Acción</th><th>Usuario</th><th>IP</th><th>Hash</th></tr></thead>
            <tbody>{datos.map((a: any) => (
              <tr key={a.id} className="clic" onClick={() => setVer(a)}>
                <td className="mono">{a.id}</td><td>{fechaHora(a.en)}</td><td>{a.tabla}</td><td>{a.accion}</td>
                <td className="mono pequeno">{a.usuario_id?.slice(0, 8) ?? 'sistema'}</td><td className="mono pequeno">{a.ip ?? ''}</td><td className="mono pequeno">{a.hash.slice(0, 12)}…</td>
              </tr>
            ))}</tbody>
          </table>
        )}
      </Tarjeta>
      <Modal abierto={!!ver} titulo={ver ? `Registro ${ver.id} · ${ver.tabla} · ${ver.accion}` : ''} onCerrar={() => setVer(null)} ancho={900}>
        {ver && (
          <div className="grid-2">
            <div><h3>Antes</h3><pre className="json">{JSON.stringify(ver.antes, null, 2) ?? '—'}</pre></div>
            <div><h3>Después</h3><pre className="json">{JSON.stringify(ver.despues, null, 2) ?? '—'}</pre></div>
          </div>
        )}
      </Modal>
    </Pagina>
  );
}
