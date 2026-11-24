import { useCallback, useEffect, useState } from 'react';
import { useEmpresa } from '../App';
import { q, rpc, sb } from '../supabase';
import { TIPOS_DOC, hoy, num, peso } from '../util';
import { AYUDA_F29 } from '../ayudas';
import { Aviso, SelectorMes } from '../componentes';

const LINEAS = [
  ['538', 'Total débitos fiscales', true],
  ['537', 'Total créditos fiscales', true],
  ['504', 'Remanente crédito fiscal mes anterior', true],
  ['89', 'IVA determinado a pagar', true],
  ['77', 'Remanente crédito fiscal para el mes siguiente', true],
  ['563', 'Base imponible PPM (ingresos netos del mes)', true],
  ['115', 'Tasa PPM (%)', false],
  ['62', 'PPM neto determinado', true],
  ['91', 'Total a pagar dentro del plazo', true],
];

export default function F29() {
  const { empresa, permite } = useEmpresa();
  const [mes, setMes] = useState(hoy().slice(0, 7));
  const [p, setP] = useState(null);
  const [guardadas, setGuardadas] = useState([]);
  const [msg, setMsg] = useState(null);
  const periodo = mes.replace('-', '');

  const cargar = useCallback(async () => {
    setP(await rpc('propuesta_f29', { p_empresa: empresa.id, p_periodo: periodo }));
    setGuardadas(await q(sb.from('f29_declaraciones').select('*').eq('empresa_id', empresa.id).order('periodo', { ascending: false }).limit(24)));
  }, [empresa.id, periodo]);
  useEffect(() => { setMsg(null); cargar().catch((e) => setMsg({ ok: false, t: e.message })); }, [cargar]);

  async function guardar() {
    try { await rpc('guardar_f29', { p_empresa: empresa.id, p_periodo: periodo }); setMsg({ ok: true, t: 'Propuesta guardada. Su remanente se usará en el mes siguiente.' }); cargar(); }
    catch (e) { setMsg({ ok: false, t: e.message }); }
  }

  return (
    <section className="hoja">
      <header className="cabecera">
        <div>
          <h1>{p ? (Number(p.lineas['91']) > 0 ? 'A pagar ' + peso(p.lineas['91']) : 'Sin pago; remanente ' + peso(p.lineas['77'])) : 'Propuesta F29'}</h1>
          <p className="chico">Formulario 29 · período {mes} · calculado desde el libro de compras y ventas</p>
        </div>
        <div className="filtros">
          <SelectorMes valor={mes} alCambiar={setMes} etiqueta="Período" />
          {permite('f29.guardar') && <button className="primario" onClick={guardar}>Guardar propuesta</button>}
        </div>
      </header>
      <Aviso msg={msg} />
      {p && (
        <>
          <div className="dos-columnas">
            <table className="tabla estado">
              <thead><tr><th data-ayuda="Número de la línea en el Formulario 29 del SII.">Código</th><th>Concepto</th><th className="n">Monto</th></tr></thead>
              <tbody>{LINEAS.map(([c, t, m]) => (
                <tr key={c} data-ayuda={AYUDA_F29[c]} className={['89', '91'].includes(c) ? 'total' + (c === '91' ? ' fuerte' : '') : ''}>
                  <td>{c}</td><td>{t}</td><td className="n">{m ? peso(p.lineas[c]) : num(p.lineas[c]).replace('.', ',')}</td></tr>
              ))}</tbody>
            </table>
            <div>
              <Resumen t="Ventas del período" filas={p.ventas} />
              <Resumen t="Compras del período" filas={p.compras} />
            </div>
          </div>
          <p className="nota">{p.nota}</p>
        </>
      )}
      <h2>Propuestas guardadas</h2>
      {guardadas.length === 0 ? <p className="vacio">Aún no hay propuestas guardadas.</p> : (
        <table className="tabla"><thead><tr><th>Período</th><th className="n">IVA determinado</th><th className="n">Remanente</th><th className="n">Total a pagar</th><th>Estado</th></tr></thead>
          <tbody>{guardadas.map((g) => (
            <tr key={g.id}><td>{g.periodo.slice(0, 4)}-{g.periodo.slice(4)}</td><td className="n">{peso(g.iva_determinado)}</td><td className="n">{peso(g.remanente_siguiente)}</td><td className="n">{peso(g.total_pagar)}</td><td>{g.estado}</td></tr>
          ))}</tbody></table>
      )}
    </section>
  );
}

function Resumen({ t, filas }) {
  return (
    <>
      <h2>{t}</h2>
      {filas.length === 0 ? <p className="vacio">Sin documentos.</p> : (
        <table className="tabla compacta"><thead><tr><th>Tipo</th><th className="n">Cant.</th><th className="n">Neto</th><th className="n">IVA</th><th className="n">Total</th></tr></thead>
          <tbody>{filas.map((f) => <tr key={f.tipo}><td>{f.tipo} {TIPOS_DOC[f.tipo]}</td><td className="n">{f.cantidad}</td><td className="n">{peso(f.neto)}</td><td className="n">{peso(f.iva)}</td><td className="n">{peso(f.total)}</td></tr>)}</tbody></table>
      )}
    </>
  );
}
