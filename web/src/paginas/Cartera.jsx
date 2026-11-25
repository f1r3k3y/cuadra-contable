import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useEmpresa } from '../App';
import { rpc } from '../supabase';
import { MESES_LARGOS, ROLES, csv, peso, rutFormato } from '../util';

const F29_TXT = { 'sin guardar': 'Sin preparar', borrador: 'Preparado, sin presentar', presentado: 'Presentado' };

// Vista para contadores con varios clientes: el estado de cada empresa en una sola tabla.
export default function Cartera() {
  const { cambiar } = useEmpresa();
  const nav = useNavigate();
  const [d, setD] = useState(null);
  const [error, setError] = useState(null);
  useEffect(() => { rpc('mi_cartera').then(setD).catch((e) => setError(e.message)); }, []);

  if (error) return <section className="hoja"><p className="aviso error">{error}</p></section>;
  if (!d) return <section className="hoja"><p>Cargando empresas…</p></section>;
  const mesAnt = `${MESES_LARGOS[Number(d.mesAnterior.slice(4)) - 1].toLowerCase()}`;
  const ir = (id, ruta) => { cambiar(id); nav(ruta); };
  const pendF29 = d.empresas.filter((e) => e.f29 && e.f29.estado !== 'presentado').length;

  return (
    <section className="hoja">
      <header className="cabecera">
        <div>
          <h1>Mis empresas ({d.empresas.length})</h1>
          <p className="chico">Estado de cada empresa donde participas. {pendF29 > 0 ? `${pendF29} con el F29 de ${mesAnt} pendiente.` : `F29 de ${mesAnt} al día en las empresas que llevas.`}</p>
        </div>
      </header>
      <div className="scroll"><table className="tabla">
        <thead><tr><th>Empresa</th><th>Tu rol</th><th data-ayuda={`Declaración de IVA de ${mesAnt}; vence el 20.`}>F29 {mesAnt}</th><th className="n">Por aprobar</th><th className="n">Docs. del mes</th>
          <th className="n">Por cobrar vencido</th><th className="n">Por pagar vencido</th><th className="n">Cartola pendiente</th><th>Sueldos {mesAnt}</th><th className="n">Meses abiertos</th></tr></thead>
        <tbody>{d.empresas.map((e) => (
          <tr key={e.id}>
            <td><button className="enlace" onClick={() => ir(e.id, '/')}>{e.razonSocial}</button><br /><small>{rutFormato(e.rut)}</small></td>
            <td>{ROLES[e.rol]}</td>
            <td>{e.f29 ? <button className="enlace" onClick={() => ir(e.id, '/f29')}>
              <span className={'etiqueta ' + (e.f29.estado === 'presentado' ? 'contabilizado' : e.f29.estado === 'borrador' ? 'borrador' : 'anulado')}>{F29_TXT[e.f29.estado]}</span></button>
              : <small>—</small>}{e.f29?.total != null && <small> {peso(e.f29.total)}</small>}</td>
            <td className="n">{e.borradores == null ? '—' : e.borradores > 0 ? <button className="enlace" onClick={() => ir(e.id, '/asientos')}>{e.borradores}</button> : 0}</td>
            <td className="n">{e.documentosMes ?? '—'}</td>
            <td className={'n' + (Number(e.cobrarVencido) > 0 ? ' error-texto' : '')}>{e.cobrarVencido == null ? '—' : peso(e.cobrarVencido)}</td>
            <td className={'n' + (Number(e.pagarVencido) > 0 ? ' error-texto' : '')}>{e.pagarVencido == null ? '—' : peso(e.pagarVencido)}</td>
            <td className="n">{e.cartolaPendiente == null ? '—' : e.cartolaPendiente > 0 ? <button className="enlace" onClick={() => ir(e.id, '/conciliacion')}>{e.cartolaPendiente}</button> : 0}</td>
            <td>{e.remuneracionesMesAnterior == null ? '—' : e.remuneracionesMesAnterior ? 'Registrados' : <button className="enlace" onClick={() => ir(e.id, '/remuneraciones')}>Pendiente</button>}</td>
            <td className="n">{e.mesesAbiertos}</td>
          </tr>
        ))}</tbody>
      </table></div>
      <p className="chico">Cada columna muestra solo lo que tu rol puede ver en esa empresa («—» si no corresponde). «Sueldos pendiente» también aparece en empresas sin trabajadores.</p>
      <button onClick={() => csv('cartera_empresas', d.empresas.map((e) => ({ Empresa: e.razonSocial, RUT: rutFormato(e.rut), Rol: ROLES[e.rol], F29: e.f29 ? F29_TXT[e.f29.estado] : '',
        TotalF29: e.f29?.total ?? '', PorAprobar: e.borradores ?? '', DocsMes: e.documentosMes ?? '', CobrarVencido: e.cobrarVencido ?? '', PagarVencido: e.pagarVencido ?? '',
        CartolaPendiente: e.cartolaPendiente ?? '', MesesAbiertos: e.mesesAbiertos })))}>Descargar CSV</button>
    </section>
  );
}
